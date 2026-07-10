import config from '@swarmmachina/standards/eslint.config.mjs'

export default [
  ...config,
  {
    rules: {
      'jsdoc/require-param-type': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-jsdoc': 'off',
      'n/no-process-exit': 'off',
      'n/no-unsupported-features/node-builtins': 'off'
    }
  }
]
