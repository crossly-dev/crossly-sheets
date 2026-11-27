'use strict';
const js = require('@eslint/js');
const globals = require('globals');

const appsScriptGlobals = {
  SpreadsheetApp: 'readonly',
  UrlFetchApp: 'readonly',
  PropertiesService: 'readonly',
  Utilities: 'readonly',
  CrosslyCore: 'readonly',
  module: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: appsScriptGlobals },
    rules: {
      'no-var': 'off',
      'no-unused-vars': ['error', { vars: 'local', args: 'none' }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
