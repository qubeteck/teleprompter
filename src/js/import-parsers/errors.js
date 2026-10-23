export class ImportError extends Error {
  constructor(message, { code = 'IMPORT_FAILED', detail = null, canOcr = false, backupFile = null } = {}) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.detail = detail;
    this.canOcr = canOcr;
    this.backupFile = backupFile;
  }
}
