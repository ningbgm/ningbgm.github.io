import { mkdir, readFile, copyFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, process.argv[2] || "site-preview");
if (!relative(root, output) || relative(root, output).startsWith("..")) {
  throw new Error("Output must be a new child directory inside this project.");
}
try {
  await readdir(output);
  throw new Error("Output already exists. Choose a new directory to preserve existing files.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
  throw new Error("FFmpeg is required to strip metadata from publication copies.");
}

const publicFiles = [
  "index.html", "web/styles.css", "web/theme.css", "web/app.js", "web/data/example_mp4.json",
  ...Array.from({ length: 5 }, (_, index) => `web/posters/case-${index + 1}.jpg`),
];
const data = JSON.parse(await readFile(join(root, "web/data/example_mp4.json"), "utf8"));
const media = new Set();
for (const category of data.categories) {
  for (const key of ["video", "audio", "image"]) media.add(category.original[key]);
  for (const row of category.rows) {
    media.add(row.output.bgm);
    media.add(row.output.vocal);
  }
}
const special = ["1_bgm.mp4", "2_bgm_2.mp4", "3_bgm_2.mp4", "4_bgm.mp4", "5_bgm.mp4"];
for (const model of ["GroundTruth", "Ours", "CMT", "Diff_bgm", "GVMGen", "M2UGen", "VeM", "VidMuse"]) {
  for (let i = 1; i <= 5; i++) {
    media.add(`demo_io/demo_compare/${model}/${i}/${model === "Ours" ? special[i - 1] : `${i}.mp4`}`);
  }
}

// An allowlist keeps raw captions and internal workspace files out of public output.
for (const file of publicFiles) {
  await mkdir(dirname(join(output, file)), { recursive: true });
  await copyFile(join(root, file), join(output, file));
}
let count = 0;
for (const file of media) {
  if (!file || !file.startsWith("demo_io/") || file.includes("..") || ![".mp4", ".mp3", ".jpg"].includes(extname(file).toLowerCase())) {
    throw new Error("Invalid media entry in publication manifest.");
  }
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  const args = ["-v", "error", "-nostdin", "-n", "-i", join(root, file), "-map", "0:v?", "-map", "0:a?", "-map_metadata", "-1", "-map_metadata:s", "-1", "-map_chapters", "-1", "-c", "copy"];
  if (extname(file).toLowerCase() === ".mp3") args.push("-id3v2_version", "0", "-write_id3v1", "0");
  if (extname(file).toLowerCase() === ".mp4") args.push("-movflags", "+faststart");
  if (extname(file).toLowerCase() === ".jpg") args.push("-update", "1");
  args.push(destination);
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Media export failed: ${file}\n${result.stderr}`);
  count++;
}
console.log(`Built ${publicFiles.length} site files and ${count} metadata-cleaned media files in ${relative(root, output)}.`);
console.log("Only publish this output directory. Visible media content still requires a separate anonymity review.");
