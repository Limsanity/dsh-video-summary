/**
 * 构建:
 *  - lib/index.js  宿主 ESM 包(@deepseek-ai/* 与 node:* 保持 external,由 dsh 运行时解析)
 *  - lib/client.js 浏览器模块,包成 window.__ModuleLoader__.load({id, factory})
 *    react / react-dom 保持 external,由宿主的模块加载器提供。
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(here, 'package.json'), 'utf8'))

mkdirSync(join(here, 'lib'), { recursive: true })

await esbuild.build({
  entryPoints: [join(here, 'src/host/index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(here, 'lib/index.js'),
  external: ['@deepseek-ai/*', 'node:*'],
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'none',
})

const banner = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `
		return module.exports;
	}
});
`

await esbuild.build({
  entryPoints: [join(here, 'src/client/index.jsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'react',
  outfile: join(here, 'lib/client.js'),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'none',
  banner: { js: banner },
  footer: { js: footer },
})

// 宿主在运行时以 `new URL('./asr.py', import.meta.url)` 找它,必须和 lib/index.js 同级
copyFileSync(join(here, 'src/host/asr.py'), join(here, 'lib/asr.py'))
copyFileSync(join(here, 'src/host/asr_mlx.py'), join(here, 'lib/asr_mlx.py'))

for (const file of ['lib/index.js', 'lib/client.js', 'lib/asr.py', 'lib/asr_mlx.py']) {
  const { size } = statSync(join(here, file))
  console.log(`${file}  ${(size / 1024).toFixed(1)} KB`)
}
