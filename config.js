// config.js - The Single Source of Truth for Aether Webstudio
const AETHER_API_CONFIG = {
  CLIENT_KEY: "sbawsb9lzwltcl6uv2",
  REDIRECT_URI: "https://moonlight-haven.github.io/AetherEnhancetest/studio.html",
  SERVER_API_ROOT: "https://aether-backend-engine.onrender.com/api"
};

// Make it accessible globally across all your other scripts explicitly
window.AETHER_API_CONFIG = AETHER_API_CONFIG;
window.config = AETHER_API_CONFIG; // Safety fallback to kill any ghost config checks
