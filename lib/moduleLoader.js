const fs = require('fs');
const path = require('path');

/*
 * loadModules(app, options)
 * -------------------------
 * Dynamically discovers and mounts modules from the `modules/` directory.
 * Each module must export a factory function in `index.js` and include a
 * `manifest.json`. Modules may expose `router` and `publicPath` properties.
 * - app: express application to mount routers/static assets on
 * - options: { loadRuntimeConfig: fn, deps: { ... } }
 * Returns: { features: [...] } describing discovered modules and whether
 * they are enabled via runtime config.
 */
function loadModules(app, options = {}) {
  const modulesDir = path.join(__dirname, '..', 'modules');
  const runtime = options.loadRuntimeConfig ? options.loadRuntimeConfig() : {};
  const enabledFeatures = (runtime.features) || {};

  const features = [];

  if (!fs.existsSync(modulesDir)) {
    console.log('No modules directory, skipping module loading');
    return { features }; // empty
  }

  const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const modPath = path.join(modulesDir, ent.name);
    try {
      const manifestPath = path.join(modPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        console.warn(`Module ${ent.name} missing manifest.json, skipping`);
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const featureId = manifest.id || ent.name;
      const enabled = typeof enabledFeatures[featureId] === 'boolean' ? enabledFeatures[featureId] : true;
      features.push({ id: featureId, displayName: manifest.displayName || manifest.id, enabled, manifest });

      if (!enabled) {
        console.log(`Module ${featureId} disabled by runtime config`);
        continue;
      }

      const moduleIndex = path.join(modPath, 'index.js');
      if (!fs.existsSync(moduleIndex)) {
        console.warn(`Module ${featureId} missing index.js, skipping`);
        continue;
      }

      // require module factory
      const factory = require(moduleIndex);
      if (typeof factory !== 'function') {
        console.warn(`Module ${featureId} index.js does not export a factory function, skipping`);
        continue;
      }

      const mod = factory(options.deps || {});
      if (mod && mod.publicPath) {
        // serve static assets under /modules/<id>/
        app.use(`/modules/${featureId}`, require('express').static(mod.publicPath));
      }
      if (mod && mod.router) {
        const mountPath = (manifest.mountPath) ? manifest.mountPath : '/';
        app.use(mountPath, mod.router);
        console.log(`Mounted module ${featureId} at ${mountPath}`);
      }
    } catch (e) {
      console.error(`Failed to load module ${ent.name}:`, e.message);
    }
  }

  // expose features list endpoint
  app.get('/api/features', (req, res) => {
    res.json(features);
  });

  return { features };
}

/* Export the loader so the server can dynamically mount modules at startup */
module.exports = { loadModules };
