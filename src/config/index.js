import fs from 'fs/promises';
import path from 'path';

export class ConfigManager {
  constructor(configPath, defaults = {}, requiredFields = ['bike', 'serverName']) {
    this.configPath = configPath;
    this.defaults = defaults;
    this.requiredFields = requiredFields;
    this.config = {};
  }

  async load() {
    try {
      const content = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(content);
      this.validate();
    } catch (error) {
      if (error.code === 'ENOENT') {
        await this.createDefault();
      } else {
        throw error;
      }
    }
    return this.config;
  }

  async save() {
    const directory = path.dirname(this.configPath);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2)
    );
  }

  async createDefault() {
    this.config = { ...this.defaults };
    await this.save();
  }

  validate() {
    const normalizedConfig = this.normalizeKeys(this.config);
    const missing = this.requiredFields.filter((field) => !(field in normalizedConfig));
    if (missing.length) {
      throw new Error(`Missing required config field(s): ${missing.join(', ')}`);
    }
    this.config = normalizedConfig;
  }

  normalizeKeys(config) {
    const normalized = {};
    for (const [key, value] of Object.entries(config)) {
      const safeKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      normalized[safeKey] = value;
    }
    return normalized;
  }
}
