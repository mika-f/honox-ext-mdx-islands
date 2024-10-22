import build from "@hono/vite-build/cloudflare-pages";
import adapter from "@hono/vite-dev-server/cloudflare";
import honox from "honox/vite";
import {
  defineConfig,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
} from "vite";

// mdx
import fs from "node:fs/promises";
import path from "node:path";
import { CompileOptions, compile } from "@mdx-js/mdx";
import mdx from "@mdx-js/rollup";
import precinct from "precinct";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";

type ResolvedId = { id: string };
type ResolveFn = (
  path: string,
  importer?: string
) => Promise<ResolvedId | null>;

const matchIslandComponentId = (id: string, islandDir: string = "/islands") => {
  const regExp = new RegExp(
    `^${islandDir}\/.+?\.tsx$|.*\/(?:\_[a-zA-Z0-9-]+\.island\.tsx$|\\\$[a-zA-Z0-9-]+\.tsx$)`
  );
  return id.match(regExp);
};

const mdxWithIslands = (opts: Readonly<CompileOptions>): Plugin => {
  const resolvedCache = new Map();
  const cache: Record<string, string> = {};
  const islandDir = "/app/islands";
  let config: ResolvedConfig;
  let root = "";
  let appPath = "";

  const walkDependencyTree = async (
    baseFile: string,
    resolve: ResolveFn,
    dependencyFile?: ResolvedId | string
  ): Promise<string[]> => {
    const depPath = dependencyFile
      ? typeof dependencyFile === "string"
        ? path.join(path.dirname(baseFile), dependencyFile) + ".tsx"
        : dependencyFile["id"]
      : baseFile;
    const deps = [depPath];

    try {
      if (!cache[depPath]) {
        cache[depPath] = (await fs.readFile(depPath, { flag: "" })).toString();
      }

      let currentFileDeps: string[];

      if (depPath.endsWith(".mdx")) {
        const js = await compile(cache[depPath], opts);
        currentFileDeps = precinct(js.value, { type: "tsx" }) as string[];
      } else {
        currentFileDeps = precinct(cache[depPath], { type: "tsx" }) as string[];
      }

      const childDeps = await Promise.all(
        currentFileDeps.map(async (file) => {
          const resolvedId = await resolve(file, baseFile);
          return await walkDependencyTree(depPath, resolve, resolvedId ?? file);
        })
      );

      deps.push(...childDeps.flat());
      return deps;
    } catch {
      return deps;
    }
  };

  return {
    name: "honox-mdx-islands",
    configResolved: async (resolveConfig) => {
      config = resolveConfig;
      appPath = path.join(config.root, "/app");
      root = config.root;
    },
    // @ts-ignore
    async transform(source, id) {
      if (id.endsWith(".mdx")) {
        const code = await compile(source, opts);
        const resolve = async (importee: string, importer?: string) => {
          if (resolvedCache.has(importee)) {
            return this.resolve(importee);
          }

          const resolvedId = await this.resolve(importee, importer);
          resolvedCache.set(importee, true);
          return resolvedId;
        };

        const hasIslandsImport = (
          await Promise.all(
            (await walkDependencyTree(id, resolve)).flat().map(async (x) => {
              const rootPath =
                "/" + path.relative(root, normalizePath(x)).replace(/\\/g, "/");
              return matchIslandComponentId(rootPath, islandDir);
            })
          )
        ).some((matched) => matched);

        if (hasIslandsImport) {
          return {
            code: `${code.value}\nexport const __importing_islands = true;`,
            map: null,
          };
        }

        return {
          code: code.value,
          map: null,
        };
      }
    },
  };
};

export default defineConfig({
  plugins: [
    mdxWithIslands({
      jsxImportSource: "hono/jsx",
      remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter],
    }),
    honox({ devServer: { adapter } }),
    build(),
  ],
});
