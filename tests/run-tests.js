/**
 * run-tests.js — 测试运行器
 * 运行：node tests/run-tests.js（或 npm test）
 * 自动发现并运行所有 *.test.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = __dirname;
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log(`🔍 发现 ${testFiles.length} 个测试文件\n`);

let totalPassed = 0, totalFailed = 0;

for (const file of testFiles) {
  console.log(`📦 ${file}`);
  try {
    const output = execSync(
      `"${process.execPath}" "${path.join(testDir, file)}"`,
      { encoding: 'utf8' }
    );
    // 提取结果行
    const resultMatch = output.match(/📊 结果: (\d+) 通过, (\d+) 失败/);
    if (resultMatch) {
      totalPassed += parseInt(resultMatch[1]);
      totalFailed += parseInt(resultMatch[2]);
    }
    process.stdout.write(output);
  } catch (e) {
    totalFailed++;
    console.error('  ❌ 测试文件执行失败: ' + e.message);
  }
  console.log('');
}

console.log('════════════════════════════');
console.log(`🎯 总计: ${totalPassed} 通过, ${totalFailed} 失败`);
console.log('════════════════════════════\n');

process.exit(totalFailed > 0 ? 1 : 0);
