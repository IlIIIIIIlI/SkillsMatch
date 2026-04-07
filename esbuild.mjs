import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @returns {import('esbuild').Plugin}
 */
function problemMatcherPlugin() {
  return {
    name: 'skillmatch-problem-matcher',
    setup(build) {
      build.onStart(() => {
        console.log(`[watch] ${build.initialOptions.outfile ?? build.initialOptions.outdir ?? 'build'} started`);
      });
      build.onEnd((result) => {
        for (const error of result.errors) {
          console.error(`✘ [ERROR] ${error.text}`);
          if (!error.location) {
            continue;
          }
          console.error(`    ${error.location.file}:${error.location.line}:${error.location.column}`);
        }
        console.log(`[watch] ${build.initialOptions.outfile ?? build.initialOptions.outdir ?? 'build'} finished`);
      });
    }
  };
}

/**
 * @param {import('esbuild').BuildOptions} options
 */
async function buildTarget(options) {
  const context = await esbuild.context({
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'warning',
    plugins: [problemMatcherPlugin()],
    ...options
  });

  if (watch) {
    await context.watch();
    return context;
  }

  await context.rebuild();
  await context.dispose();
  return undefined;
}

async function main() {
  const contexts = [];

  const extensionContext = await buildTarget({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
  });

  if (extensionContext) {
    contexts.push(extensionContext);
  }

  const webviewContext = await buildTarget({
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: ['chrome120'],
    globalName: 'SkillMapWebview'
  });

  if (webviewContext) {
    contexts.push(webviewContext);
  }

  if (!watch) {
    return;
  }

  const dispose = async () => {
    for (const context of contexts) {
      await context.dispose();
    }
    process.exit(0);
  };

  process.on('SIGINT', dispose);
  process.on('SIGTERM', dispose);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
