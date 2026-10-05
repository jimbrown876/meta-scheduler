// Loaded by Playwright MCP's documented --init-page hook, never from a queue job.
exports.default = async ({ page }) => {
  const configPath = process.env.GWT_DESKTOP_CONFIG;
  if (!configPath?.startsWith('/')) throw new Error('CONFIG_INVALID');
  const { loadConfig, runPublisher, safeFailure } = await import('./publisher-cli.js');
  const { sshQueue } = await import('./desktop-transport.js');
  const { connectionLost } = await import('./desktop-errors.js');
  Object.defineProperty(page, 'runGwtDesktop', {
    value: async mode => {
      if (!['status', 'sync', 'canary'].includes(mode)) throw new Error('MODE_INVALID');
      try {
        const config = loadConfig(configPath);
        if (config.browserMode !== 'extension') throw new Error('CONFIG_INVALID');
        if (mode === 'canary') {
          const { runDesktopCanary } = await import('./desktop-canary.js');
          return await runDesktopCanary(page, config);
        }
        return await runPublisher(mode, config, {
          verifyLease: async () => {
            const lease = JSON.parse(process.env.GWT_DESKTOP_LEASE || 'null');
            if (!lease || typeof lease.worker !== 'string' || typeof lease.lease !== 'string') throw new Error('QUEUE_LEASE_REQUIRED');
            await sshQueue(config, 'check', lease);
          },
          launch: async () => ({
            setDefaultTimeout: value => page.setDefaultTimeout(value),
            newPage: async () => page,
            // The desktop owns Chrome. The MCP client closes only its task tab.
            close: async () => {},
          }),
        });
      } catch (error) {
        const network = error instanceof TypeError && /fetch failed/i.test(error.message);
        // The next attempt may read back a persisted uncertain intent, but may
        // never repeat its Publish click without a verified receipt.
        const pending = /needs reconciliation/.test(error.message);
        return { ok: false, code: pending ? 'FACEBOOK_READBACK_PENDING' : network ? 'CATALOG_UNAVAILABLE' : connectionLost(error) ? 'FACEBOOK_DESKTOP_UNAVAILABLE' : safeFailure(error), ...(error.cause ? { detail: safeFailure(error.cause) } : {}), ...(error.previewDiagnostics ? { previewDiagnostics: error.previewDiagnostics } : {}) };
      }
    },
    writable: false,
    configurable: false,
  });
};
