import createDebug from 'debug'
import d3TimeFormat from 'd3-time-format'
import eventToPromise from 'event-to-promise'
import find from 'lodash.find'
import got from 'got'
import includes from 'lodash.includes'
import sortBy from 'lodash.sortby'
import unzip from 'julien-f-unzip'
import { PassThrough } from 'stream'
import { request as httpRequest } from 'http'
import { stringify as formatQueryString } from 'querystring'
import {
  wrapError as wrapXapiError,
  Xapi as XapiBase
} from 'xen-api'

import {debounce} from './decorators'
import {
  camelToSnakeCase,
  createRawObject,
  ensureArray,
  forEach,
  mapToArray,
  noop,
  parseXml,
  pFinally,
  pSettle
} from './utils'
import {JsonRpcError} from './api-errors'

const debug = createDebug('xo:xapi')

// ===================================================================

const OPAQUE_REF_RE = /OpaqueRef:[0-9a-z-]+/
function extractOpaqueRef (str) {
  const matches = OPAQUE_REF_RE.exec(str)
  if (!matches) {
    throw new Error('no opaque ref found')
  }
  return matches[0]
}

// ===================================================================

const typeToNamespace = createRawObject()
forEach([
  'Bond',
  'DR_task',
  'GPU_group',
  'PBD',
  'PCI',
  'PGPU',
  'PIF',
  'PIF_metrics',
  'SM',
  'SR',
  'VBD',
  'VBD_metrics',
  'VDI',
  'VGPU',
  'VGPU_type',
  'VLAN',
  'VM',
  'VM_appliance',
  'VM_guest_metrics',
  'VM_metrics',
  'VMPP',
  'VTPM'
], namespace => {
  typeToNamespace[namespace.toLowerCase()] = namespace
})

// Object types given by `xen-api` are always lowercase but the
// namespaces in the Xen API can have a different casing.
const getNamespaceForType = (type) => typeToNamespace[type] || type

// ===================================================================

// Format a date (pseudo ISO 8601) from one XenServer get by
// xapi.call('host.get_servertime', host.$ref) for example
export const formatDateTime = d3TimeFormat.utcFormat('%Y%m%dT%H:%M:%SZ')

export const parseDateTime = formatDateTime.parse

export const isHostRunning = (host) => {
  const {$metrics: metrics} = host

  return metrics && metrics.live
}

const VM_RUNNING_POWER_STATES = {
  Running: true,
  Paused: true
}
export const isVmRunning = (vm) => VM_RUNNING_POWER_STATES[vm.power_state]

export const isVmHvm = (vm) => Boolean(vm.HVM_boot_policy)

// ===================================================================

export default class Xapi extends XapiBase {
  constructor (...args) {
    super(...args)

    const objectsWatchers = this._objectWatchers = createRawObject()
    const taskWatchers = this._taskWatchers = createRawObject()

    const onAddOrUpdate = objects => {
      forEach(objects, object => {
        const {
          $id: id,
          $ref: ref
        } = object

        // Watched object.
        if (id in objectsWatchers) {
          objectsWatchers[id].resolve(object)
          delete objectsWatchers[id]
        }
        if (ref in objectsWatchers) {
          objectsWatchers[ref].resolve(object)
          delete objectsWatchers[ref]
        }

        // Watched task.
        if (ref in taskWatchers) {
          const {status} = object

          if (status === 'success') {
            taskWatchers[ref].resolve(object.result)
          } else if (status === 'failure') {
            taskWatchers[ref].reject(wrapXapiError(object.error_info))
          } else {
            return
          }

          delete taskWatchers[ref]
        }
      })
    }
    this.objects.on('add', onAddOrUpdate)
    this.objects.on('update', onAddOrUpdate)
  }

  // =================================================================

  // Wait for an object to appear or to be updated.
  //
  // TODO: implements a timeout.
  _waitObject (idOrUuidOrRef) {
    let watcher = this._objectWatchers[idOrUuidOrRef]
    if (!watcher) {
      let resolve
      const promise = new Promise(resolve_ => {
        resolve = resolve_
      })

      // Register the watcher.
      watcher = this._objectWatchers[idOrUuidOrRef] = {
        promise,
        resolve
      }
    }

    return watcher.promise
  }

  // Returns the objects if already presents or waits for it.
  async _getOrWaitObject (idOrUuidOrRef) {
    return (
      this.getObject(idOrUuidOrRef, undefined) ||
      this._waitObject(idOrUuidOrRef)
    )
  }

  // =================================================================

  // Create a task.
  async _createTask (name = 'untitled task', description = '') {
    const ref = await this.call('task.create', `[XO] ${name}`, description)
    debug('task created: %s', name)

    this._watchTask(ref)::pFinally(() => {
      this.call('task.destroy', ref).then(() => {
        debug('task destroyed: %s', name)
      })
    })

    return ref
  }

  // Waits for a task to be resolved.
  _watchTask (ref) {
    // If a task object is passed, unpacked the ref.
    if (typeof ref === 'object' && ref.$ref) ref = ref.$ref

    let watcher = this._taskWatchers[ref]
    if (!watcher) {
      let resolve, reject
      const promise = new Promise((resolve_, reject_) => {
        resolve = resolve_
        reject = reject_
      })

      // Register the watcher.
      watcher = this._taskWatchers[ref] = {
        promise,
        resolve,
        reject
      }
    }

    return watcher.promise
  }

  // =================================================================

  async _setObjectProperties (object, props) {
    const {
      $ref: ref,
      $type: type
    } = object

    const namespace = getNamespaceForType(type)

    // TODO: the thrown error should contain the name of the
    // properties that failed to be set.
    await Promise.all(mapToArray(props, (value, name) => {
      if (value != null) {
        return this.call(`${namespace}.set_${camelToSnakeCase(name)}`, ref, value)
      }
    }))
  }

  async setHostProperties (id, {
    nameLabel,
    nameDescription
  }) {
    await this._setObjectProperties(this.getObject(id), {
      nameLabel,
      nameDescription
    })
  }

  async setPoolProperties ({
    autoPowerOn,
    nameLabel,
    nameDescription
  }) {
    const { pool } = this

    const promises = [
      this._setObjectProperties(pool, {
        nameLabel,
        nameDescription
      })
    ]

    // TODO: mutualize this code.
    if (autoPowerOn != null) {
      let p = this.call('pool.remove_from_other_config', pool.$ref, 'auto_poweron')

      if (autoPowerOn) {
        p = p
          .catch(noop)
          .then(() => this.call('pool.add_to_other_config', pool.$ref, 'auto_poweron', 'true'))
      }

      promises.push(p)
    }

    await Promise.all(promises)
  }

  async setSrProperties (id, {
    nameLabel,
    nameDescription
  }) {
    await this._setObjectProperties(this.getObject(id), {
      nameLabel,
      nameDescription
    })
  }

  // =================================================================

  async addTag (id, tag) {
    const {
      $ref: ref,
      $type: type
    } = this.getObject(id)

    const namespace = getNamespaceForType(type)
    await this.call(`${namespace}.add_tags`, ref, tag)
  }

  async removeTag (id, tag) {
    const {
      $ref: ref,
      $type: type
    } = this.getObject(id)

    const namespace = getNamespaceForType(type)
    await this.call(`${namespace}.remove_tags`, ref, tag)
  }

  // =================================================================

  // FIXME: should be static
  @debounce(24 * 60 * 60 * 1000)
  async _getXenUpdates () {
    const {body, statusCode} = await got(
      'http://updates.xensource.com/XenServer/updates.xml'
    )

    if (statusCode !== 200) {
      throw new JsonRpcError('cannot fetch patches list from Citrix')
    }

    const {patchdata: data} = parseXml(body)

    const patches = createRawObject()
    forEach(data.patches.patch, patch => {
      patches[patch.uuid] = {
        date: patch.timestamp,
        description: patch['name-description'],
        documentationUrl: patch.url,
        guidance: patch['after-apply-guidance'],
        name: patch['name-label'],
        url: patch['patch-url'],
        uuid: patch.uuid,
        conflicts: mapToArray(ensureArray(patch.conflictingpatches), patch => {
          return patch.conflictingpatch.uuid
        }),
        requirements: mapToArray(ensureArray(patch.requiredpatches), patch => {
          return patch.requiredpatch.uuid
        })
        // TODO: what does it mean, should we handle it?
        // version: patch.version,
      }
      if (patches[patch.uuid].conflicts[0] === undefined) {
        patches[patch.uuid].conflicts.length = 0
      }
      if (patches[patch.uuid].requirements[0] === undefined) {
        patches[patch.uuid].requirements.length = 0
      }
    })

    const resolveVersionPatches = function (uuids) {
      const versionPatches = createRawObject()

      forEach(uuids, ({uuid}) => {
        versionPatches[uuid] = patches[uuid]
      })

      return versionPatches
    }

    const versions = createRawObject()
    let latestVersion
    forEach(data.serverversions.version, version => {
      versions[version.value] = {
        date: version.timestamp,
        name: version.name,
        id: version.value,
        documentationUrl: version.url,
        patches: resolveVersionPatches(version.patch)
      }

      if (version.latest) {
        latestVersion = versions[version.value]
      }
    })

    return {
      patches,
      latestVersion,
      versions
    }
  }

  // =================================================================

  async joinPool (masterAddress, masterUsername, masterPassword, force = false) {
    await this.call(
      force ? 'pool.join_force' : 'pool.join',
      masterAddress,
      masterUsername,
      masterPassword
    )
  }

  // =================================================================

  // Returns installed and not installed patches for a given host.
  async _getPoolPatchesForHost (host) {
    const { product_version: version } = host.software_version

    return (await this._getXenUpdates()).versions[version].patches
  }

  _getInstalledPoolPatchesOnHost (host) {
    const installed = createRawObject()

    forEach(host.$patches, hostPatch => {
      installed[hostPatch.$pool_patch.uuid] = true
    })

    return installed
  }

  async _listMissingPoolPatchesOnHost (host) {
    const all = await this._getPoolPatchesForHost(host)
    const installed = this._getInstalledPoolPatchesOnHost(host)

    const installable = createRawObject()
    forEach(all, (patch, uuid) => {
      if (installed[uuid]) {
        return
      }

      for (const uuid of patch.conflicts) {
        if (uuid in installed) {
          return
        }
      }

      installable[uuid] = patch
    })

    return installable
  }

  async listMissingPoolPatchesOnHost (hostId) {
    // Returns an array to not break compatibility.
    return mapToArray(
      await this._listMissingPoolPatchesOnHost(this.getObject(hostId))
    )
  }

  // -----------------------------------------------------------------

  _isPoolPatchInstallableOnHost (patchUuid, host) {
    const installed = this._getInstalledPoolPatchesOnHost(host)

    if (installed[patchUuid]) {
      return false
    }

    let installable = true

    forEach(installed, patch => {
      if (includes(patch.conflicts, patchUuid)) {
        installable = false

        return false
      }
    })

    return installable
  }

  // -----------------------------------------------------------------

  async uploadPoolPatch (stream, length, patchName = 'unknown') {
    const taskRef = await this._createTask('Upload: ' + patchName)

    const [, patchRef] = await Promise.all([
      got('http://' + this.pool.$master.address + '/pool_patch_upload', {
        method: 'put',
        body: stream,
        query: {
          session_id: this.sessionId,
          task_id: taskRef
        },
        headers: {
          'content-length': length
        }
      }),
      this._watchTask(taskRef)
    ])

    return this._getOrWaitObject(patchRef)
  }

  async _getOrUploadPoolPatch (uuid) {
    try {
      return this.getObjectByUuid(uuid)
    } catch (error) {}

    debug('downloading patch %s', uuid)

    const patchInfo = (await this._getXenUpdates()).patches[uuid]
    if (!patchInfo) {
      throw new Error('no such patch ' + uuid)
    }

    const PATCH_RE = /\.xsupdate$/
    const proxy = new PassThrough()
    got.stream(patchInfo.url).on('error', error => {
      // TODO: better error handling
      console.error(error)
    }).pipe(unzip.Parse()).on('entry', entry => {
      if (PATCH_RE.test(entry.path)) {
        proxy.emit('length', entry.size)
        entry.pipe(proxy)
      } else {
        entry.autodrain()
      }
    }).on('error', error => {
      // TODO: better error handling
      console.error(error)
    })

    const length = await eventToPromise(proxy, 'length')
    return this.uploadPoolPatch(proxy, length, patchInfo.name)
  }

  // -----------------------------------------------------------------

  async _installPoolPatchOnHost (patchUuid, host) {
    debug('installing patch %s', patchUuid)

    const patch = await this._getOrUploadPoolPatch(patchUuid)
    await this.call('pool_patch.apply', patch.$ref, host.$ref)
  }

  async installPoolPatchOnHost (patchUuid, hostId) {
    return await this._installPoolPatchOnHost(
      patchUuid,
      this.getObject(hostId)
    )
  }

  // -----------------------------------------------------------------

  async installPoolPatchOnAllHosts (patchUuid) {
    const patch = await this._getOrUploadPoolPatch(patchUuid)

    await this.call('pool_patch.pool_apply', patch.$ref)
  }

  // -----------------------------------------------------------------

  async _installPoolPatchOnHostAndRequirements (patch, host, patchesByUuid) {
    const { requirements } = patch
    if (requirements.length) {
      for (const requirementUuid of requirements) {
        if (this._isPoolPatchInstallableOnHost(requirementUuid, host)) {
          const requirement = patchesByUuid[requirementUuid]
          await this._installPoolPatchOnHostAndRequirements(requirement, host, patchesByUuid)

          host = this.getObject(host.$id)
        }
      }
    }

    await this._installPoolPatchOnHost(patch.uuid, host)
  }

  async installAllPoolPatchesOnHost (hostId) {
    let host = this.getObject(hostId)

    const installableByUuid = await this._listMissingPoolPatchesOnHost(host)

    // List of all installable patches sorted from the newest to the
    // oldest.
    const installable = sortBy(
      installableByUuid,
      patch => -Date.parse(patch.date)
    )

    for (let i = 0, n = installable.length; i < n; ++i) {
      const patch = installable[i]

      if (this._isPoolPatchInstallableOnHost(patch.uuid, host)) {
        await this._installPoolPatchOnHostAndRequirements(patch, host, installableByUuid)
        host = this.getObject(host.$id)
      }
    }
  }

  async emergencyShutdownHost (hostId) {
    const host = this.getObject(hostId)
    const vms = host.$resident_VMs
    debug(`Emergency shutdown: ${host.name_label}`)
    await pSettle(
      mapToArray(vms, vm => {
        if (!vm.is_control_domain) {
          return this.call('VM.suspend', vm.$ref)
        }
      })
    )
    await this.call('host.disable', host.$ref)
    await this.call('host.shutdown', host.$ref)
  }

  // =================================================================

  // Disable the host and evacuate all its VMs.
  //
  // If `force` is false and the evacuation failed, the host is re-
  // enabled and the error is thrown.
  async _clearHost ({ $ref: ref }, force) {
    await this.call('host.disable', ref)

    try {
      await this.call('host.evacuate', ref)
    } catch (error) {
      if (!force) {
        await this.call('host.enabled', ref)

        throw error
      }
    }
  }

  async disableHost (hostId) {
    await this.call('host.disable', this.getObject(hostId).$ref)
  }

  async ejectHostFromPool (hostId) {
    await this.call('pool.eject', this.getObject(hostId).$ref)
  }

  async enableHost (hostId) {
    await this.call('host.enable', this.getObject(hostId).$ref)
  }

  async powerOnHost (hostId) {
    await this.call('host.power_on', this.getObject(hostId).$ref)
  }

  async rebootHost (hostId, force = false) {
    const host = this.getObject(hostId)

    await this._clearHost(host, force)
    await this.call('host.reboot', host.$ref)
  }

  async restartHostAgent (hostId) {
    await this.call('host.restart_agent', this.getObject(hostId).$ref)
  }

  async shutdownHost (hostId, force = false) {
    const host = this.getObject(hostId)

    await this._clearHost(host, force)
    await this.call('host.shutdown', host.$ref)
  }

  // =================================================================

  // Clone a VM: make a fast copy by fast copying each of its VDIs
  // (using snapshots where possible) on the same SRs.
  async _cloneVm (vm, nameLabel = vm.name_label) {
    return await this.call('VM.clone', vm.$ref, nameLabel)
  }

  // Copy a VM: make a normal copy of a VM and all its VDIs.
  //
  // If a SR is specified, it will contains the copies of the VDIs,
  // otherwise they will use the SRs they are on.
  async _copyVm (vm, nameLabel = vm.nameLabel, sr = undefined) {
    let snapshotRef
    if (isVmRunning(vm)) {
      snapshotRef = await this._snapshotVm(vm)
    }

    try {
      return await this.call(
        'VM.copy',
        snapshotRef || vm.$ref,
        nameLabel,
        sr ? sr.$ref : ''
      )
    } finally {
      if (snapshotRef) {
        await this.deleteVm(
          await this._getOrWaitObject(snapshotRef),
          true
        )
      }
    }
  }

  async _snapshotVm (vm, nameLabel = vm.name_label) {
    let ref
    try {
      ref = await this.call('VM.snapshot_with_quiesce', vm.$ref, nameLabel)
      this.addTag(ref, 'quiesce').catch(noop) // ignore any failures
    } catch (error) {
      if (
        error.code !== 'VM_SNAPSHOT_WITH_QUIESCE_NOT_SUPPORTED' &&
        error.code !== 'VM_BAD_POWER_STATE' // quiesce only work on a running VM
      ) {
        throw error
      }
      ref = await this.call('VM.snapshot', vm.$ref, nameLabel)
    }
    // Convert the template to a VM.
    await this.call('VM.set_is_a_template', ref, false)

    return ref
  }

  async cloneVm (vmId, {
    nameLabel = undefined,
    fast = true
  } = {}) {
    const vm = this.getObject(vmId)

    const cloneRef = await (
      fast
        ? this._cloneVm(vm, nameLabel)
        : this._copyVm(vm, nameLabel)
    )

    return await this._getOrWaitObject(cloneRef)
  }

  async copyVm (vmId, srId, {
    nameLabel = undefined
  } = {}) {
    return await this._getOrWaitObject(
      await this._copyVm(
        this.getObject(vmId),
        nameLabel,
        this.getObject(srId)
      )
    )
  }

  async remoteCopyVm (vmId, targetXapi, targetSrId, {
    compress = true,
    nameLabel = undefined
  } = {}) {
    const sr = targetXapi.getObject(targetSrId)
    const stream = await this.exportVm(vmId, {
      compress,
      onlyMetadata: false
    })

    const vm = await targetXapi._getOrWaitObject(
      await targetXapi._importVm(stream, stream.length, sr)
    )

    if (nameLabel !== undefined) {
      await targetXapi._setObjectProperties(vm, {
        nameLabel
      })
    }

    return vm
  }

  // TODO: clean up on error.
  async createVm (templateId, {
    nameDescription = undefined,
    nameLabel = undefined,
    pvArgs = undefined,
    cpus = undefined,
    installRepository = undefined,
    vdis = [],
    vifs = []
  } = {}) {
    const installMethod = (() => {
      if (installRepository == null) {
        return 'none'
      }

      try {
        installRepository = this.getObject(installRepository)
        return 'cd'
      } catch (_) {
        return 'network'
      }
    })()

    const template = this.getObject(templateId)

    // Clones the template.
    const vm = await this._getOrWaitObject(
      await this._cloneVm(template, nameLabel)
    )

    // TODO: copy BIOS strings?

    // Removes disks from the provision XML, we will create them by
    // ourselves.
    await this.call('VM.remove_from_other_config', vm.$ref, 'disks').catch(noop)

    // Creates the VDIs and executes the initial steps of the
    // installation.
    await this.call('VM.provision', vm.$ref)

    // Set VMs params.
    this._setObjectProperties(vm, {
      nameDescription,
      PV_args: pvArgs,
      VCPUs_at_startup: cpus
    })

    // Sets boot parameters.
    {
      const isHvm = isVmHvm(vm)

      if (isHvm) {
        if (!vdis.length || installMethod === 'network') {
          const { HVM_boot_params: bootParams } = vm
          let order = bootParams.order
          if (order) {
            order = 'n' + order.replace('n', '')
          } else {
            order = 'ncd'
          }

          this._setObjectProperties(vm, {
            HVM_boot_params: { ...bootParams, order }
          })
        }
      } else { // PV
        if (vm.PV_bootloader === 'eliloader') {
          // Removes any preexisting entry.
          await this.call('VM.remove_from_other_config', vm.$ref, 'install-repository').catch(noop)

          if (installMethod === 'network') {
            // TODO: normalize RHEL URL?

            await this.call('VM.add_to_other_config', vm.$ref, 'install-repository', installRepository)
          } else if (installMethod === 'cd') {
            await this.call('VM.add_to_other_config', vm.$ref, 'install-repository', 'cdrom')
          }
        }
      }
    }

    // Inserts the CD if necessary.
    if (installMethod === 'cd') {
      // When the VM is started, if PV, the CD drive will become not
      // bootable and the first disk bootable.
      await this._insertCdIntoVm(installRepository, vm, {
        bootable: true
      })
    }

    // Creates the VDIs.
    //
    // TODO: set vm.suspend_SR
    await Promise.all(mapToArray(vdis, (vdiDescription, i) => {
      return this._createVdi(
        vdiDescription.size,
        {
          name_label: vdiDescription.name_label,
          name_description: vdiDescription.name_description,
          sr: vdiDescription.sr || vdiDescription.SR
        }
      )
        .then(ref => this._getOrWaitObject(ref))
        .then(vdi => this._createVbd(vm, vdi, {
          // Only the first VBD if installMethod is not cd is bootable.
          bootable: installMethod !== 'cd' && !i
        }))
    }))

    // Destroys the VIFs cloned from the template.
    await Promise.all(mapToArray(vm.$vifs, vif => this._deleteVif(vif)))

    // Creates the VIFs specified by the user.
    {
      let position = 0
      await Promise.all(mapToArray(vifs, vif => this._createVif(
        vm,
        this.getObject(vif.network),
        {
          position: position++,
          mac: vif.mac,
          mtu: vif.mtu
        }
      )))
    }

    // TODO: Create Cloud config drives.

    // TODO: Assign VGPUs.

    return vm
  }

  async _deleteVm (vm, deleteDisks) {
    if (isVmRunning(vm)) {
      throw new Error('running VMs cannot be deleted')
    }

    if (deleteDisks) {
      await Promise.all(mapToArray(vm.$VBDs, vbd => {
        // DO not remove CDs and Floppies.
        if (vbd.type === 'Disk') {
          return this._deleteVdi(vbd.$VDI).catch(noop)
        }
      }))
    }

    await Promise.all(mapToArray(vm.$snapshots, snapshot => {
      return this.deleteVm(snapshot.$id, true).catch(noop)
    }))

    await this.call('VM.destroy', vm.$ref)
  }

  async deleteVm (vmId, deleteDisks = false) {
    return await this._deleteVm(
      this.getObject(vmId),
      deleteDisks
    )
  }

  getVmConsole (vmId) {
    const vm = this.getObject(vmId)

    const console = find(vm.$consoles, { protocol: 'rfb' })
    if (!console) {
      throw new Error('no RFB console found')
    }

    return console
  }

  // Returns a stream to the exported VM.
  async exportVm (vmId, {
    compress = true,
    onlyMetadata = false
  } = {}) {
    const vm = this.getObject(vmId)

    let host
    let snapshotRef
    if (isVmRunning(vm)) {
      host = vm.$resident_on
      snapshotRef = await this._snapshotVm(vm)
    } else {
      host = this.pool.$master
    }

    const taskRef = await this._createTask('VM Export', vm.name_label)
    if (snapshotRef) {
      this._watchTask(taskRef)::pFinally(() => {
        this.deleteVm(snapshotRef, true)
      })
    }

    const stream = got.stream({
      hostname: host.address,
      path: onlyMetadata ? '/export_metadata/' : '/export/'
    }, {
      query: {
        ref: snapshotRef || vm.$ref,
        session_id: this.sessionId,
        task_id: taskRef,
        use_compression: compress ? 'true' : 'false'
      }
    })

    const response = await eventToPromise(stream, 'response')

    const { headers: {
      'content-length': length
    } } = response
    if (length) {
      stream.length = length
    }

    // TODO: remove when no longer used.
    stream.response = response

    return stream
  }

  async _migrateVMWithStorageMotion (vm, hostXapi, host, {
    migrationNetwork = find(host.$PIFs, pif => pif.management).$network, // TODO: handle not found
    sr = host.$pool.$default_SR, // TODO: handle not found
    vifsMap = {}
  }) {
    const vdis = {}
    for (const vbd of vm.$VBDs) {
      if (vbd.type !== 'CD') {
        vdis[vbd.$VDI.$ref] = sr.$ref
      }
    }

    const token = await hostXapi.call(
      'host.migrate_receive',
      host.$ref,
      migrationNetwork.$ref,
      {}
    )

    await this.call(
      'VM.migrate_send',
      vm.$ref,
      token,
      true, // Live migration.
      vdis,
      vifsMap,
      {
        force: 'true'
      }
    )
  }

  async _putVmWithoutLength (hostname, stream, query) {
    const request = httpRequest({
      hostname,
      method: 'PUT',
      path: '/import/?' + formatQueryString(query)
    })
    request.removeHeader('transfer-encoding')

    stream.pipe(request)

    // An error can occur after the finish event and therefore will
    // not be handled by eventToPromise().
    //
    // As a consequence, add an empty error handler to avoid a crash.
    request.on('error', noop)

    await eventToPromise(request, 'finish')

    // The request will never finish because the XAPI has no way to no
    // it is finished, therefore it will never send a response.
    request.abort()
  }

  async _importVm (stream, length, sr) {
    const taskRef = await this._createTask('VM import')

    const query = {
      session_id: this.sessionId,
      task_id: taskRef
    }

    let host
    if (sr) {
      host = sr.$PBDs[0].$host
      query.sr_id = sr.$ref
    } else {
      host = this.pool.$master
    }

    const upload = length
      ? got.put({
        hostname: host.address,
        path: '/import/'
      }, {
        body: stream,
        headers: { 'content-length': length },
        query
      })
      : this._putVmWithoutLength(host.address, stream, query)

    const [, vmRef] = await Promise.all([
      upload,
      this._watchTask(taskRef).then(extractOpaqueRef)
    ])

    return vmRef
  }

  // TODO: an XVA can contain multiple VMs
  async importVm (stream, length, {
    srId
  } = {}) {
    return await this._getOrWaitObject(await this._importVm(
      stream,
      length,
      srId && this.getObject(srId)
    ))
  }

  async migrateVm (vmId, hostXapi, hostId, {
    migrationNetworkId,
    networkId,
    srId
  } = {}) {
    const vm = this.getObject(vmId)
    if (!isVmRunning(vm)) {
      throw new Error('cannot migrate a non-running VM')
    }

    const host = hostXapi.getObject(hostId)

    const accrossPools = vm.$pool !== host.$pool
    const useStorageMotion = (
      accrossPools ||
      migrationNetworkId ||
      networkId ||
      srId
    )

    if (useStorageMotion) {
      const vifsMap = {}
      if (accrossPools || networkId) {
        const {$ref: networkRef} = networkId
          ? this.getObject(networkId)
          : find(host.$PIFs, pif => pif.management).$network
        for (const vif of vm.$VIFs) {
          vifsMap[vif.$ref] = networkRef
        }
      }

      await this._migrateVMWithStorageMotion(vm, hostXapi, host, {
        migrationNetwork: migrationNetworkId && this.getObject(migrationNetworkId),
        sr: srId && this.getObject(srId),
        vifsMap
      })
    } else {
      try {
        await this.call('VM.pool_migrate', vm.$ref, host.$ref, { force: 'true' })
      } catch (error) {
        if (error.code !== 'VM_REQUIRES_SR') {
          throw error
        }

        // Retry using motion storage.
        await this._migrateVMWithStorageMotion(vm, hostXapi, host, {})
      }
    }
  }

  async snapshotVm (vmId, nameLabel = undefined) {
    return await this._getOrWaitObject(
      await this._snapshotVm(
        this.getObject(vmId),
        nameLabel
      )
    )
  }

  // =================================================================

  async _createVbd (vm, vdi, {
    bootable = false,
    position = undefined,
    type = 'Disk',
    readOnly = (type !== 'Disk')
  }) {
    if (position == null) {
      const allowed = await this.call('VM.get_allowed_VBD_devices', vm.$ref)
      const {length} = allowed
      if (!length) {
        throw new Error('no allowed VBD positions (devices)')
      }

      if (type === 'CD') {
        // Choose position 3 if allowed.
        position = includes(allowed, '3')
          ? '3'
          : allowed[0]
      } else {
        position = allowed[0]

        // Avoid position 3 if possible.
        if (position === '3' && length > 1) {
          position = allowed[1]
        }
      }
    }

    // By default a VBD is unpluggable.
    const vbdRef = await this.call('VBD.create', {
      bootable,
      empty: false,
      mode: readOnly ? 'RO' : 'RW',
      other_config: {},
      qos_algorithm_params: {},
      qos_algorithm_type: '',
      type,
      userdevice: String(position),
      VDI: vdi.$ref,
      VM: vm.$ref
    })

    if (isVmRunning(vm)) {
      await this.call('VBD.plug', vbdRef)
    }

    return vbdRef
  }

  async _createVdi (size, {
    name_label = '',
    name_description = undefined,
    sr = this.pool.default_SR
  } = {}) {
    return await this.call('VDI.create', {
      name_label: name_label,
      name_description: name_description,
      other_config: {},
      read_only: false,
      sharable: false,
      SR: this.getObject(sr).$ref,
      type: 'user',
      virtual_size: String(size)
    })
  }

  // TODO: check whether the VDI is attached.
  async _deleteVdi (vdi) {
    await this.call('VDI.destroy', vdi.$ref)
  }

  _getVmCdDrive (vm) {
    for (const vbd of vm.$VBDs) {
      if (vbd.type === 'CD') {
        return vbd
      }
    }
  }

  async _ejectCdFromVm (vm) {
    const cdDrive = this._getVmCdDrive(vm)
    if (cdDrive) {
      await this.call('VBD.eject', cdDrive.$ref)
    }
  }

  async _insertCdIntoVm (cd, vm, {
    bootable = false,
    force = false
  } = {}) {
    const cdDrive = await this._getVmCdDrive(vm)
    if (cdDrive) {
      try {
        await this.call('VBD.insert', cdDrive.$ref, cd.$ref)
      } catch (error) {
        if (!force || error.code !== 'VBD_NOT_EMPTY') {
          throw error
        }

        await this.call('VBD.eject', cdDrive.$ref).catch(noop)

        // Retry.
        await this.call('VBD.insert', cdDrive.$ref, cd.$ref)
      }

      if (bootable !== Boolean(cdDrive.bootable)) {
        await this._setObjectProperties(cdDrive, {bootable})
      }
    } else {
      await this._createVbd(vm, cd, {
        bootable,
        type: 'CD'
      })
    }
  }

  async attachVdiToVm (vdiId, vmId, opts = undefined) {
    await this._createVbd(
      this.getObject(vmId),
      this.getObject(vdiId),
      opts
    )
  }

  async createVdi (size, opts) {
    return await this._getOrWaitObject(
      await this._createVdi(size, opts)
    )
  }

  async deleteVdi (vdiId) {
    await this._deleteVdi(this.getObject(vdiId))
  }

  async ejectCdFromVm (vmId) {
    await this._ejectCdFromVm(this.getObject(vmId))
  }

  async insertCdIntoVm (cdId, vmId, opts = undefined) {
    await this._insertCdIntoVm(
      this.getObject(cdId),
      this.getObject(vmId),
      opts
    )
  }

  // =================================================================

  async _createVif (vm, network, {
    mac = '',
    mtu = 1500,
    position = undefined
  } = {}) {
    // TODO: use VM.get_allowed_VIF_devices()?
    if (position == null) {
      forEach(vm.$VIFs, vif => {
        const curPos = +vif.device
        if (!(position > curPos)) {
          position = curPos
        }
      })

      position = position == null ? 0 : position + 1
    }

    const vifRef = await this.call('VIF.create', {
      device: String(position),
      MAC: String(mac),
      MTU: String(mtu),
      network: network.$ref,
      other_config: {},
      qos_algorithm_params: {},
      qos_algorithm_type: '',
      VM: vm.$ref
    })

    if (isVmRunning(vm)) {
      await this.call('VIF.plug', vifRef)
    }

    return vifRef
  }

  // TODO: check whether the VIF was unplugged before.
  async _deleteVif (vif) {
    await this.call('VIF.destroy', vif.$ref)
  }

  async createVif (vmId, networkId, opts = undefined) {
    return await this._getOrWaitObject(
      await this._createVif(
        this.getObject(vmId),
        this.getObject(networkId),
        opts
      )
    )
  }

  async deleteVif (vifId) {
    await this._deleteVif(this.getObject(vifId))
  }

  // =================================================================

  async _doDockerAction (vmId, action, containerId) {
    const vm = this.getObject(vmId)
    const host = vm.$resident_on || this.pool.$master

    return await this.call('host.call_plugin', host.$ref, 'xscontainer', action, {
      vmuuid: vm.uuid,
      container: containerId
    })
  }

  async registerDockerContainer (vmId) {
    await this._doDockerAction(vmId, 'register')
  }

  async deregisterDockerContainer (vmId) {
    await this._doDockerAction(vmId, 'deregister')
  }

  async startDockerContainer (vmId, containerId) {
    await this._doDockerAction(vmId, 'start', containerId)
  }

  async stopDockerContainer (vmId, containerId) {
    await this._doDockerAction(vmId, 'stop', containerId)
  }

  async restartDockerContainer (vmId, containerId) {
    await this._doDockerAction(vmId, 'restart', containerId)
  }

  async pauseDockerContainer (vmId, containerId) {
    await this._doDockerAction(vmId, 'pause', containerId)
  }

  async unpauseDockerContainer (vmId, containerId) {
    await this._doDockerAction(vmId, 'unpause', containerId)
  }

  async getCloudInitConfig (templateId) {
    const template = this.getObject(templateId)
    const host = this.pool.$master

    let config = await this.call('host.call_plugin', host.$ref, 'xscontainer', 'get_config_drive_default', {
      templateuuid: template.uuid
    })
    return config.slice(4) // FIXME remove the "True" string on the begining
  }

  async createCloudInitConfigDrive (vmId, srId, config) {
    const vm = this.getObject(vmId)
    const host = this.pool.$master
    const sr = this.getObject(srId)

    await this.call('host.call_plugin', host.$ref, 'xscontainer', 'create_config_drive', {
      vmuuid: vm.uuid,
      sruuid: sr.uuid,
      configuration: config
    })
  }

  // =================================================================

}