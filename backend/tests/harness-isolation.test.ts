import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('test startup rejects a previously cached development schema before opening an application',()=>{
  const script = `
    const { config } = require(${JSON.stringify(resolve(__dirname,'../src/config.js'))});
    config.schema = 'public';
    const { harness } = require(${JSON.stringify(resolve(__dirname,'helpers.js'))});
    harness().start().then(() => process.exitCode = 1).catch(error => {
      if (!error.message.includes('Tests must resolve their isolated schema')) throw error;
      console.log('rejected-before-start');
    });
  `;
  const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'rejected-before-start');
});
