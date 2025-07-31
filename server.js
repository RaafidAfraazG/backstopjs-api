const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = 3000; // Changed to 3000 for consistency

// Directories
const uploadsDir = "temp_uploads";
const referenceDir = "backstop_data/bitmaps_reference";
const testDir = "backstop_data/bitmaps_test";
const diffImagesDir = "diff_images";
const htmlReportDir = "backstop_data/html_report";

const upload = multer({ dest: uploadsDir });

// Ensure directories exist
["backstop_data", uploadsDir, referenceDir, testDir, diffImagesDir, htmlReportDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Store uploaded images
const uploadedImages = new Map();

// Create BackstopJS config
function createBackstopConfig(testCases) {
  const scenarios = testCases.map(testCase => ({
    label: testCase,
    url: `http://127.0.0.1:${PORT}/serve-image/${testCase}`,
    selectors: ["body"],
    misMatchThreshold: 0.1,
    requireSameDimensions: false,
    delay: 1000
  }));

  return {
    id: "visual_regression",
    viewports: [{ label: "desktop", width: 1280, height: 800 }],
    scenarios: scenarios,
    paths: {
      bitmaps_reference: referenceDir,
      bitmaps_test: testDir,
      html_report: htmlReportDir,
      ci_report: "backstop_data/ci_report"
    },
    report: ["CI"],
    engine: "puppeteer",
    engineOptions: {
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    },
    asyncCaptureLimit: 1,
    asyncCompareLimit: 1
  };
}

// Serve uploaded images
app.get("/serve-image/:testCase", (req, res) => {
  const { testCase } = req.params;
  const { mode } = req.query;

  let imageKey = mode === 'reference' ? `${testCase}_reference` : `${testCase}_current`;
  let imageData = uploadedImages.get(imageKey);

  if (!imageData && !mode) {
    imageKey = `${testCase}_reference`;
    imageData = uploadedImages.get(imageKey);
  }

  if (!imageData || !fs.existsSync(imageData.path)) {
    return res.status(404).send("Image not found");
  }

  const imageBuffer = fs.readFileSync(imageData.path);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType = imageData.mimetype || 'image/png';

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
          img { max-width: 100%; max-height: 100vh; }
        </style>
      </head>
      <body>
        <img src="data:${mimeType};base64,${imageBase64}" alt="${testCase}" />
      </body>
    </html>
  `);
});

// Update BackstopJS config
function updateBackstopConfig(testCases) {
  const config = createBackstopConfig(testCases);
  fs.writeFileSync("backstop.selenium.json", JSON.stringify(config, null, 2));
}

// Run BackstopJS command
async function runBackstopCommand(command, testCase) {
  return new Promise((resolve, reject) => {
    const args = ['backstop', command, '--config=backstop.selenium.json', `--filter=${testCase}`];
    const child = spawn('npx', args);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => stdout += data.toString());
    child.stderr.on('data', (data) => stderr += data.toString());

    child.on('close', (code) => {
      if (code === 0 || (command === 'test' && stdout.includes('report'))) {
        resolve({ success: true, hasDifferences: code !== 0, stdout, stderr });
      } else {
        reject(new Error(`BackstopJS failed with code ${code}: ${stderr}`));
      }
    });

    child.on('error', reject);
  });
}

// Find and copy diff image
function findAndCopyDiffImage(testCase) {
  try {
    if (!fs.existsSync(testDir)) return { found: false };

    const allFiles = fs.readdirSync(testDir).map(f => path.join(testDir, f));

    const diffFile = allFiles.find(filePath => {
      const name = path.basename(filePath).toLowerCase();
      return name.includes(testCase.toLowerCase()) &&
             (name.includes('diff') || name.includes('failed')) &&
             name.endsWith('.png');
    });

    if (diffFile) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destPath = path.join(diffImagesDir, `${testCase}_${timestamp}_diff.png`);

      fs.copyFileSync(diffFile, destPath);

      const diffBase64 = fs.readFileSync(destPath).toString('base64');

      return { found: true, path: destPath, originalPath: diffFile, base64: diffBase64 };
    }

    return { found: false };
  } catch (error) {
    return { found: false, error: error.message };
  }
}

// Main BackstopJS endpoint
app.post("/backstop", upload.single("image"), async (req, res) => {
  const { testCase, mode } = req.body;
  const uploadedFile = req.file;

  if (!testCase || !mode || !uploadedFile) {
    return res.status(400).json({
      success: false,
      message: "Missing required parameters: testCase, mode, and image file"
    });
  }

  if (!["reference", "current"].includes(mode)) {
    return res.status(400).json({
      success: false,
      message: "Mode must be 'reference' or 'current'"
    });
  }

  try {
    const imageKey = `${testCase}_${mode}`;
    uploadedImages.set(imageKey, {
      path: uploadedFile.path,
      mimetype: uploadedFile.mimetype,
      originalname: uploadedFile.originalname
    });

    if (mode === "reference") {
      updateBackstopConfig([testCase]);
      await new Promise(resolve => setTimeout(resolve, 500));

      await runBackstopCommand('reference', testCase);

      return res.json({
        success: true,
        message: `Reference screenshot captured for: ${testCase}`
      });
    }

    if (mode === "current") {
      const referenceKey = `${testCase}_reference`;
      if (!uploadedImages.has(referenceKey)) {
        return res.status(400).json({
          success: false,
          message: `No reference image found for test case: ${testCase}. Please upload reference image first.`
        });
      }

      updateBackstopConfig([testCase]);
      await new Promise(resolve => setTimeout(resolve, 500));

      const result = await runBackstopCommand('test', testCase);
      const backstopResult = result.hasDifferences ? "failed" : "passed";

      const diffInfo = findAndCopyDiffImage(testCase);

      const response = {
        success: true,
        testCase,
        result: backstopResult,
        message: backstopResult === "passed"
          ? "No visual differences detected"
          : "Visual differences found"
      };

      if (diffInfo.found) {
        response.diffImage = diffInfo.path;
        response.diffImageBase64 = diffInfo.base64;
      }

      return res.json(response);
    }

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`BackstopJS API running at http://0.0.0.0:${PORT}`);
});
