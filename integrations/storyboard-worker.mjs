// One private process/job: upstream caches, cell maps and viewing history never cross conversations.
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const directory = path.resolve(process.argv[2]);
process.env.DSH_VIDEO_CACHE_DIR = path.join(directory, 'cache');
process.env.DSH_HOME = directory;
const options = JSON.parse(await fs.readFile(path.join(directory, 'options.json'), 'utf8'));
// Upstream normally accepts URLs. This bridge only hands it private local files;
// retain the bridge's file/pipe decoder boundary even with a full FFmpeg build.
for (const method of ['spawn', 'execFile']) {
  const original = childProcess[method];
  childProcess[method] = function(binary, args, ...rest) {
    const media = binary === options.ffmpegPath || binary === options.ffprobePath;
    if (media && !args.includes('-version')) args = ['-protocol_whitelist', 'file,pipe', ...args];
    return original.call(this, binary, args, ...rest);
  };
  if (method === 'execFile') {
    childProcess[method][promisify.custom] = (binary, args, options = {}) => new Promise((resolve, reject) => {
      childProcess.execFile(binary, args, options, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    });
  }
}
syncBuiltinESMExports();
const { runStoryboard } = await import('dsh-video-storyboard/pipeline');
const result = await runStoryboard({ ...options, cache: false, ocr: false, frameConcurrency: 2 });
const sheets = [];
for (const [i, sheet] of result.sheets.entries()) {
  await fs.writeFile(path.join(directory, `sheet-${i}.png`), sheet.png);
  sheets.push({ sheet: sheet.sheet, cols: sheet.cols, rows: sheet.rows, width: sheet.width, height: sheet.height,
    cells: sheet.cells.map(cell => ({ ...cell, ...(cell.text ? { text: cell.text.slice(0, options.textChars) } : {}) })) });
}
console.log(JSON.stringify({ window: result.window, cuts: result.cuts.length, sheets,
  audio: result.audio ? { summary: result.audio.summary, events: result.audio.events?.slice(0, 12) } : null,
  plan: { produced: result.plan.produced, cell: result.plan.cell, sub: result.plan.sub }, timing: result.timing }));
