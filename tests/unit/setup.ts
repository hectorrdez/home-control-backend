// Runs before every unit test file. dotenv never overrides variables that are
// already set, so these values win over the developer's local .env: unit tests
// must never reach a real Home Assistant, an API key, or a real aliases file.
process.env.HA_URL = "http://ha.test:8123";
process.env.HA_TOKEN = "test-ha-token";
process.env.API_TOKEN = "";
process.env.CORS_ORIGINS = "";
process.env.LOG_TO_FILE = "false";
