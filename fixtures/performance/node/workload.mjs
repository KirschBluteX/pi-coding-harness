const arm = process.argv[2];
if (arm !== "BASELINE" && arm !== "CANDIDATE") process.exit(2);
process.stdout.write(JSON.stringify({ value: arm === "BASELINE" ? 100 : 90, unit: "ms", quality: "PASS" }));
