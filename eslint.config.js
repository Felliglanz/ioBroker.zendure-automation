'use strict';

const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'admin/**']
    },
    {
        files: ['**/*.js'],
        ignores: ['www/**'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart'],
            'no-console': 'off'
        }
    },
    {
        files: ['www/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser
            }
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart']
        }
    }
];
