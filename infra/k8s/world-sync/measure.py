#!/usr/bin/env python3
"""M1 measurement: delta tar stream + time-to-ready. Run in-cluster, not a controller."""
import os, time, urllib.request, sys

SRC = os.environ["SOURCE_SYNC_URL"]  # http://svc-a:8080/stream
DST_HOST = os.environ["DEST_HOST"]
WORLD_SIZE_HINT = os.environ.get("WORLD_SIZE", "unknown")

def timed(label, fn):
    t0 = time.time()
    fn()
    ms = int((time.time() - t0) * 1000)
    print(f"{label}_ms={ms}")
    return ms

def presync():
    urllib.request.urlopen(SRC, timeout=600).read()

if __name__ == "__main__":
    print(f"world_size={WORLD_SIZE_HINT}")
    timed("presync", presync)
    print("Run freeze by hand: save-off, save-all flush, POST /stream?delta=1, save-on")
    print("Then start Paper on B and measure cold_boot_ms from process start to TCP 25565")
