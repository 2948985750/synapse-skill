"use strict";

const fs = require("node:fs");
const path = require("node:path");

function validateUploadFiles(files) {
  if (!Array.isArray(files)) throw Object.assign(new Error("files must be an array"), { code: "VALIDATION" });
  return files.map((file) => {
    if (typeof file !== "string" || !file || file.includes("\0")) throw Object.assign(new Error("file paths must be non-empty strings"), { code: "VALIDATION" });
    const absolute = path.resolve(file);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (cause) {
      throw Object.assign(new Error("Upload file is unavailable: " + absolute, { cause }), { code: "INVALID_FILE" });
    }
    if (!stat.isFile()) throw Object.assign(new Error("Upload path is not a regular file: " + absolute), { code: "INVALID_FILE" });
    return absolute;
  });
}

module.exports = { validateUploadFiles };
