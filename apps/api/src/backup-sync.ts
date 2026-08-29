import "dotenv/config";
import { syncBackupsFromS3 } from "./modules/backup/sync";

async function loop() {
  try {
    await syncBackupsFromS3();
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  while (true) {
    await loop();
    await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
  }
}
run();
