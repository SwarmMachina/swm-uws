import config from '@swarmmachina/standards/eslint.config.mjs'

export default [
  { ignores: ['test/v8-snapshot-shapes.js'] },
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
