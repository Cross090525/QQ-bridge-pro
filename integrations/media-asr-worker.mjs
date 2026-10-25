// Invoked only with administrator-configured module/model and a private job WAV.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sherpa = require(process.argv[2]);
const model = process.argv[3];
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { senseVoice: { model: path.join(model, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
    tokens: path.join(model, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
});
const bytes = fs.readFileSync(process.argv[4]);
if (!bytes.length || bytes.length % 4 || bytes.length > 16000 * 180 * 4) throw Error('Invalid bounded audio samples');
const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples });
recognizer.decode(stream);
console.log(JSON.stringify(recognizer.getResult(stream)));
