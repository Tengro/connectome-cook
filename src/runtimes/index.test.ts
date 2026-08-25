/**
 * Tests for the shared clone-command assembly in runtimes/index.ts —
 * especially the CA-pinning (`caCert`) and clone-username (`authUsername`)
 * behavior, and the byte-exact legacy shapes that existing deployments
 * (and boter's sentinel-guarded hand-patches) diff against.
 */
import { describe, expect, test } from 'bun:test';
import type { McpSource } from '../types.js';
import {
  caCertContainerPath,
  caCertContextPath,
  cloneUsername,
  collectCaCerts,
  gitCloneCommand,
  secretMountFlag,
} from './index.js';

function source(overrides: Partial<McpSource> = {}): McpSource {
  return {
    key: 'https://git.ath/x/notion-mcp@main',
    url: 'https://git.ath/x/notion-mcp.git',
    ref: 'main',
    install: { kind: 'npm' },
    inContainerPath: '/notion-mcp',
    refs: [{ recipePath: '/r.json', mcpServerName: 'notion' }],
    ...overrides,
  };
}

describe('gitCloneCommand — legacy shapes stay byte-identical', () => {
  test('plain public clone', () => {
    expect(gitCloneCommand(source(), '/notion-mcp'))
      .toBe('git clone https://git.ath/x/notion-mcp.git /notion-mcp');
  });

  test('authSecret without authUsername still emits oauth2 userinfo, verbatim', () => {
    expect(gitCloneCommand(source({ authSecret: 'GITLAB_TOKEN' }), '/notion-mcp'))
      .toBe('git clone "https://oauth2:$(cat /run/secrets/GITLAB_TOKEN)@git.ath/x/notion-mcp.git" /notion-mcp');
  });

  test('sslBypass alone still emits sslVerify=false, verbatim', () => {
    expect(gitCloneCommand(source({ authSecret: 'GITLAB_TOKEN', sslBypass: true }), '/notion-mcp'))
      .toBe('git -c http.sslVerify=false clone "https://oauth2:$(cat /run/secrets/GITLAB_TOKEN)@git.ath/x/notion-mcp.git" /notion-mcp');
  });
});

describe('gitCloneCommand — caCert', () => {
  test('pins TLS to the in-image CA copy instead of disabling verification', () => {
    const cmd = gitCloneCommand(
      source({ authSecret: 'GITLAB_TOKEN', caCert: '/home/op/certs/ath-ca.crt' }),
      '/notion-mcp',
    );
    expect(cmd).toBe(
      'git -c http.sslCAInfo=/tmp/cook-ca/ath-ca.crt clone '
      + '"https://oauth2:$(cat /run/secrets/GITLAB_TOKEN)@git.ath/x/notion-mcp.git" /notion-mcp',
    );
    expect(cmd).not.toContain('sslVerify=false');
  });

  test('applies to uncredentialed clones too (internal CA, public repo)', () => {
    expect(gitCloneCommand(source({ caCert: '/certs/ca.pem' }), '/notion-mcp'))
      .toBe('git -c http.sslCAInfo=/tmp/cook-ca/ca.pem clone https://git.ath/x/notion-mcp.git /notion-mcp');
  });

  test('wins over sslBypass if a hand-built source carries both', () => {
    const cmd = gitCloneCommand(
      source({ caCert: '/certs/ca.pem', sslBypass: true }),
      '/notion-mcp',
    );
    expect(cmd).toContain('http.sslCAInfo=/tmp/cook-ca/ca.pem');
    expect(cmd).not.toContain('sslVerify=false');
  });

  test('rejects a basename with shell-hostile characters', () => {
    expect(() => gitCloneCommand(source({ caCert: '/certs/my ca.pem' }), '/x'))
      .toThrow(/rename the CA bundle file/);
  });
});

describe('gitCloneCommand — authUsername', () => {
  test('replaces the oauth2 userinfo (GitLab deploy tokens)', () => {
    expect(gitCloneCommand(
      source({ authSecret: 'DEPLOY_TOKEN', authUsername: 'gitlab+deploy-token-42' }),
      '/notion-mcp',
    )).toBe('git clone "https://gitlab+deploy-token-42:$(cat /run/secrets/DEPLOY_TOKEN)@git.ath/x/notion-mcp.git" /notion-mcp');
  });

  test('is ignored without authSecret (validator rejects the combo anyway)', () => {
    expect(gitCloneCommand(source({ authUsername: 'whoever' }), '/notion-mcp'))
      .toBe('git clone https://git.ath/x/notion-mcp.git /notion-mcp');
  });

  test('refuses shell metacharacters even on a hand-built source', () => {
    for (const bad of ['a$(id)', 'a b', 'a"b', 'a`b', 'a\\b']) {
      expect(() => gitCloneCommand(
        source({ authSecret: 'T', authUsername: bad }),
        '/x',
      )).toThrow(/refusing to splice/);
    }
  });

  test('cloneUsername defaults to oauth2', () => {
    expect(cloneUsername({})).toBe('oauth2');
    expect(cloneUsername({ authUsername: 'gitlab+deploy-token-1' })).toBe('gitlab+deploy-token-1');
  });
});

describe('caCert path helpers + collectCaCerts', () => {
  test('context and container paths derive from the basename', () => {
    const s = source({ caCert: '/home/op/certs/ath-ca.crt' });
    expect(caCertContextPath(s)).toBe('ca-certs/ath-ca.crt');
    expect(caCertContainerPath(s)).toBe('/tmp/cook-ca/ath-ca.crt');
  });

  test('dedupes by host path across sources', () => {
    const list = collectCaCerts([
      source({ caCert: '/certs/ath-ca.crt' }),
      source({ key: 'other', caCert: '/certs/ath-ca.crt' }),
      source({ key: 'plain' }),
    ]);
    expect(list).toEqual([{ hostPath: '/certs/ath-ca.crt', contextPath: 'ca-certs/ath-ca.crt' }]);
  });

  test('errors on distinct files sharing a basename', () => {
    expect(() => collectCaCerts([
      source({ caCert: '/a/ca.crt' }),
      source({ key: 'other', caCert: '/b/ca.crt' }),
    ])).toThrow(/basename collision/);
  });
});

describe('secretMountFlag (unchanged contract)', () => {
  test('empty without authSecret, mount flag with it', () => {
    expect(secretMountFlag(source())).toBe('');
    expect(secretMountFlag(source({ authSecret: 'GITLAB_TOKEN' })))
      .toBe('--mount=type=secret,id=GITLAB_TOKEN ');
  });
});
