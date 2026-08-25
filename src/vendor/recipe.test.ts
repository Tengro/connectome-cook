/**
 * Tests for the cook-owned auth/TLS source fields on the vendored recipe
 * validator: `caCert` (CA pinning) and `authUsername` (clone userinfo).
 * These fields are cook extensions — not (yet) in upstream connectome-host's
 * validateRecipe — so their contract is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from './recipe.js';

/** Minimal valid recipe with one git-sourced MCP server. */
function recipeWithSource(source: Record<string, unknown>): unknown {
  return {
    name: 'T',
    agent: { systemPrompt: 'x' },
    mcpServers: {
      internal: {
        command: 'node',
        source: { url: 'https://git.example/x/y.git', ...source },
      },
    },
  };
}

/** Same, declared on an extensions.*.source block. */
function recipeWithExtensionSource(source: Record<string, unknown>): unknown {
  return {
    name: 'T',
    agent: { systemPrompt: 'x' },
    extensions: {
      zk: {
        kind: 'module',
        path: './src/index.ts',
        source: { url: 'https://git.example/x/y.git', ...source },
      },
    },
  };
}

describe('validateRecipe — source.caCert', () => {
  test('accepts a plain caCert path', () => {
    expect(() => validateRecipe(recipeWithSource({ caCert: './certs/internal-ca.crt' })))
      .not.toThrow();
  });

  test('rejects caCert + sslBypass as contradictory', () => {
    expect(() => validateRecipe(recipeWithSource({ caCert: 'ca.crt', sslBypass: true })))
      .toThrow(/caCert and sslBypass are contradictory/);
  });

  test('caCert + sslBypass: false is fine (explicit false is not a bypass)', () => {
    expect(() => validateRecipe(recipeWithSource({ caCert: 'ca.crt', sslBypass: false })))
      .not.toThrow();
  });

  test('rejects non-string and empty caCert', () => {
    expect(() => validateRecipe(recipeWithSource({ caCert: 42 })))
      .toThrow(/caCert must be a non-empty string/);
    expect(() => validateRecipe(recipeWithSource({ caCert: '' })))
      .toThrow(/caCert must be a non-empty string/);
  });

  test('rejects a caCert basename with shell-hostile characters', () => {
    expect(() => validateRecipe(recipeWithSource({ caCert: './certs/my ca.crt' })))
      .toThrow(/must contain only/);
    // Directory components may contain spaces — only the basename lands in
    // the generated Dockerfile.
    expect(() => validateRecipe(recipeWithSource({ caCert: './my certs/ca.crt' })))
      .not.toThrow();
  });

  test('validates on extensions.*.source too', () => {
    expect(() => validateRecipe(recipeWithExtensionSource({ caCert: 'ca.crt', sslBypass: true })))
      .toThrow(/extensions\.zk\.source: caCert and sslBypass are contradictory/);
  });
});

describe('validateRecipe — source.authUsername', () => {
  test('accepts a GitLab deploy-token username alongside authSecret', () => {
    expect(() => validateRecipe(recipeWithSource({
      authSecret: 'GITLAB_DEPLOY_TOKEN',
      authUsername: 'gitlab+deploy-token-42',
    }))).not.toThrow();
  });

  test('rejects authUsername without authSecret', () => {
    expect(() => validateRecipe(recipeWithSource({ authUsername: 'gitlab+deploy-token-42' })))
      .toThrow(/only meaningful together with authSecret/);
  });

  test('rejects usernames with URL/shell metacharacters', () => {
    for (const bad of ['a b', 'a:b', 'a@b', 'a$(id)b', 'a"b', 'a`b', '']) {
      expect(() => validateRecipe(recipeWithSource({ authSecret: 'T', authUsername: bad })))
        .toThrow(/authUsername must be a string of/);
    }
  });

  test('validates on extensions.*.source too', () => {
    expect(() => validateRecipe(recipeWithExtensionSource({ authUsername: 'x' })))
      .toThrow(/extensions\.zk\.source\.authUsername is only meaningful/);
  });
});
