import Icon from 'icon'
import PropTypes from 'prop-types'
import React from 'react'

export const FormGroup = props => <div {...props} className='form-group' />
export const Input = props => <input {...props} className='form-control' />
export const Ul = props => <ul {...props} className='list-group' />
export const Li = props => <li {...props} className='list-group-item' />

export const getRandomId = () =>
  Math.random()
    .toString(36)
    .slice(2)

export const FormFeedback = ({
  showError,
  error,
  component: Component,
  ...props
}) => (
  <div>
    <Component
      {...props}
      style={
        showError === undefined
          ? undefined
          : {
              borderColor: showError ? 'red' : 'green',
            }
      }
    />
    {showError && (
      <span className='text-danger'>
        <Icon icon='alarm' /> {error}
      </span>
    )}
  </div>
)

FormFeedback.propTypes = {
  component: PropTypes.node.isRequired,
  error: PropTypes.node.isRequired,
  showError: PropTypes.bool,
}
