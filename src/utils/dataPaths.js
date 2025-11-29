import os from "os";
import path from "path";
import fs from "fs";

export function getDataDirectory() {
  const home = os.homedir();
  let baseDir;

  if (process.platform === "win32") {
    baseDir =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(home, "AppData", "Local");
  } else if (process.platform === "darwin") {
    baseDir = path.join(home, "Library", "Application Support");
  } else {
    baseDir = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  }

  const dataDir = path.join(baseDir, "llm-threader");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}
