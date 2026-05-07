'use strict';

require('dotenv').config();

const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload }    = require('@aws-sdk/lib-storage');
const { BatchClient, SubmitJobCommand } = require('@aws-sdk/client-batch');

// ── Config ─────────────────────────────────────────────────────────────────────

const FILE_ID       = process.env.FILE_ID;
const S3_KEY        = process.env.S3_KEY;
const FILE_EXT      = (process.env.FILE_EXT || '').toLowerCase();
const BUCKET        = process.env.S3_BUCKET;
const JOB_QUEUE     = process.env.BATCH_JOB_QUEUE;
const JOB_DEF       = process.env.BATCH_JOB_DEFINITION;
const TMP_BASE      = process.env.CONVERSION_TMP_DIR
  || (fs.existsSync('/mnt/conversion-tmp') ? '/mnt/conversion-tmp' : os.tmpdir());

if (!FILE_ID || !S3_KEY || !FILE_EXT || !BUCKET) {
  console.error('Missing required env vars: FILE_ID, S3_KEY, FILE_EXT, S3_BUCKET');
  process.exit(1);
}

if (FILE_EXT !== 'rcp') {
  console.error(`This service only handles .rcp files, got: ${FILE_EXT}`);
  process.exit(1);
}

if (!JOB_QUEUE || !JOB_DEF) {
  console.error('Missing required env vars: BATCH_JOB_QUEUE, BATCH_JOB_DEFINITION');
  process.exit(1);
}

const region = process.env.AWS_REGION || 'eu-west-3';
const s3     = new S3Client({ region });
const batch  = new BatchClient({ region });

// ── S3 helpers ─────────────────────────────────────────────────────────────────

async function downloadFromS3(s3Key, localPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(localPath);
    res.Body.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function uploadFileToS3(localPath, s3Key) {
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: s3Key, Body: fs.createReadStream(localPath) },
  });
  await upload.done();
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function convert() {
  const workDir = path.join(TMP_BASE, `geo-conv-rcp-${FILE_ID}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // ── Step 1: Download RCP from S3 ──────────────────────────────────────────
    const rcpPath = path.join(workDir, 'original.rcp');
    console.log(`[${FILE_ID}] Downloading from S3: ${S3_KEY}`);
    await downloadFromS3(S3_KEY, rcpPath);

    // ── Step 2: RCP → E57 via CloudCompare ───────────────────────────────────
    // CloudCompare saves output in its cwd; run it from an isolated subdir.
    const ccOutDir = path.join(workDir, 'cc-out');
    fs.mkdirSync(ccOutDir, { recursive: true });

    console.log(`[${FILE_ID}] Converting RCP → E57 via CloudCompare`);
    try {
      execSync(`CloudCompare -SILENT -O "${rcpPath}" -C_EXPORT_FMT E57 -SAVE_CLOUDS`, {
        cwd:     ccOutDir,
        stdio:   ['ignore', 'pipe', 'pipe'],
        timeout: 60 * 60 * 1000,
      });
    } catch (err) {
      const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
      throw new Error(`RCP→E57 CloudCompare failed:\n${out || err.message}`);
    }

    const e57Candidates = fs.readdirSync(ccOutDir).filter(f => f.toLowerCase().endsWith('.e57'));
    if (!e57Candidates.length) throw new Error('CloudCompare produced no .e57 output — verify the QRDB_IO plugin is present in the image');
    const e57LocalPath = path.join(ccOutDir, e57Candidates[0]);
    console.log(`[${FILE_ID}] CloudCompare output: ${e57Candidates[0]} (${(fs.statSync(e57LocalPath).size / (1024 * 1024)).toFixed(0)} MB)`);

    // ── Step 3: Upload E57 to S3 ──────────────────────────────────────────────
    const e57S3Key = `raw/${FILE_ID}/converted.e57`;
    console.log(`[${FILE_ID}] Uploading E57 to S3: ${e57S3Key}`);
    await uploadFileToS3(e57LocalPath, e57S3Key);

    // ── Step 4: Trigger standard conversion job (E57 → Potree + panoramas) ───
    console.log(`[${FILE_ID}] Submitting standard conversion job for E57`);
    await batch.send(new SubmitJobCommand({
      jobName:       `geodraft-convert-e57-${FILE_ID}`,
      jobQueue:      JOB_QUEUE,
      jobDefinition: JOB_DEF,
      containerOverrides: {
        environment: [
          { name: 'FILE_ID',  value: FILE_ID   },
          { name: 'S3_KEY',   value: e57S3Key  },
          { name: 'FILE_EXT', value: 'e57'     },
        ],
      },
    }));

    console.log(`[${FILE_ID}] RCP→E57 complete — standard job submitted`);
    process.exit(0);
  } catch (err) {
    console.error(`[${FILE_ID}] Conversion failed:`, err.message);
    process.exit(1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

convert();
