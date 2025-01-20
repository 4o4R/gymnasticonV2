import fs from 'fs/promises';
import path from 'path';

export class ConfigManager {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = {};
  }

  async load() {
    try {
      const content = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(content);
      this.validate();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.createDefault();
    }
    return this.config;
  }

  async save() {
    await fs.writeFile(
      this.configPath,
      JSON.stringify(this.config, null, 2)
    );
  }

  validate() {
    const requiredFields = ['bike', 'power-scale', 'server-name'];
    for (const field of requiredFields) {
      if (!(field in this.config)) {
        throw new Error(`Missing required config field: ${field}`);
      }
    }
  }
}
