// Read the frozen baseline palette fixture without requiring legacy git history.
const fs = require('node:fs');
const path = require('node:path'), vm = require('node:vm');
const {createRequire} = require('node:module');
const workspace = path.resolve(__dirname, '../..');
const fixture = path.join(workspace, 'tests/fixtures/baseline-palette-13302d4.js');
const source = fs.readFileSync(fixture, 'utf8');
const moduleObject = {exports: {}};
vm.runInNewContext(source, {
  module: moduleObject, require: createRequire(path.join(workspace, 'site/palette.js')),
}, {filename: 'tests/fixtures/baseline-palette-13302d4.js'});
module.exports = {BaselinePalette: moduleObject.exports.Palette, source};
