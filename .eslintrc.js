module.exports = {
  root: true,
  env: {
    commonjs: true,
    node: true,
    mocha: true,
  },
  extends: ['airbnb-base'],
  rules: {
    'max-len': [
      'error',
      {
        code: 200,
        ignoreUrls: true,
        ignoreTrailingComments: true,
      },
    ],
    'no-console': 'off',
    'default-param-last': 'off',
    'import/extensions': ['error', 'never'],
    'linebreak-style': ['error', 'unix'],
  },
  parserOptions: {
    ecmaVersion: 'latest',
  },
};
