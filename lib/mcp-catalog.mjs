// @ts-check
/**
 * Curated catalog of well-known MCP servers, shown in the Settings UI to
 * spare users from typing npm package names and looking up env var names.
 * Each entry is a template — picking one pre-fills the Add form with the
 * right command/args/url and surfaces which env vars or headers the user
 * needs to supply.
 *
 * Curation policy: only include servers I'm confident actually work today
 * with the listed package name and shape. The user can always add anything
 * not in the catalog via the manual Add form.
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} id                  template id (matches the entry below)
 * @property {string} defaultServerId     suggested mcp server id when adding
 * @property {string} displayName
 * @property {string} description
 * @property {string} icon                emoji shown on the card
 * @property {string} docsUrl
 * @property {'stdio'|'http'} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Array<{ key: string, label: string, hint?: string, placeholder?: string }>} [requiredEnv]
 * @property {string} [url]
 * @property {Array<{ key: string, label: string, hint?: string, placeholder?: string }>} [requiredHeaders]
 * @property {string[]} [setupSteps]      bullet list shown above the form
 */

/** @type {CatalogEntry[]} */
export const CATALOG = [
  {
    id: 'everything',
    defaultServerId: 'everything',
    displayName: 'Everything (reference)',
    description: 'The official MCP demo server — exposes example tools (echo, get-sum, get-tiny-image, …) for testing your setup.',
    icon: '🧪',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
  {
    id: 'filesystem',
    defaultServerId: 'filesystem',
    displayName: 'Filesystem',
    description: 'Read, search, and (optionally) write files within an allowlisted directory on this host. Useful for "summarize my notes" / "find the file that contains X".',
    icon: '📁',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/alex/Documents'],
    setupSteps: [
      'Edit the path in the args (last entry) to the folder you want exposed.',
      'The server only sees files under that path; nothing else on the host.',
    ],
  },
  {
    id: 'memory',
    defaultServerId: 'memory',
    displayName: 'Memory (knowledge graph)',
    description: 'A persistent knowledge-graph memory the agent can write entities, relations, and observations into across sessions.',
    icon: '🧠',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'fetch',
    defaultServerId: 'fetch',
    displayName: 'Fetch',
    description: 'Make HTTP requests and read web pages. A simpler/lighter alternative to a full browser.',
    icon: '🌐',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  {
    id: 'github',
    defaultServerId: 'github',
    displayName: 'GitHub',
    description: 'Read repos, search issues, create PRs, comment, and more — anything the GitHub REST/GraphQL APIs expose. Great for the coder agent.',
    icon: '🐙',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnv: [
      {
        key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'GitHub Personal Access Token',
        hint: 'Generate at github.com/settings/tokens (Fine-grained or Classic). Scope it to the repos and operations you want the agent to perform.',
        placeholder: 'ghp_...',
      },
    ],
    setupSteps: [
      'Generate a Personal Access Token at github.com/settings/tokens.',
      'Give it the scopes you want the agent to use (e.g. repo for full repo access, or fine-grained per-repo).',
      'Paste the token below.',
    ],
  },
  {
    id: 'postgres',
    defaultServerId: 'postgres',
    displayName: 'PostgreSQL (read-only)',
    description: 'Run read-only SQL queries against a PostgreSQL database. Good for "what are my top customers this month?" style questions.',
    icon: '🐘',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:password@host:5432/dbname'],
    setupSteps: [
      'Edit the connection string in the args. Use a read-only role for safety.',
      'Network from this OE host must reach your database.',
    ],
  },
  {
    id: 'sqlite',
    defaultServerId: 'sqlite',
    displayName: 'SQLite',
    description: 'Read/write a local SQLite database file. Useful for the agent to keep structured per-session state.',
    icon: '🗃️',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '/tmp/agent.db'],
    setupSteps: [
      'Change the DB path in args to wherever you want the file stored.',
    ],
  },
  {
    id: 'brave-search',
    defaultServerId: 'brave-search',
    displayName: 'Brave Search',
    description: 'Web and local search via the Brave Search API.',
    icon: '🦁',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnv: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave API key',
        hint: 'Free tier available at api.search.brave.com — sign up and grab a key.',
        placeholder: 'BSAxxx...',
      },
    ],
  },
  {
    id: 'puppeteer',
    defaultServerId: 'puppeteer',
    displayName: 'Puppeteer (browser)',
    description: 'Drive a headless Chromium for browsing, screenshotting, and DOM interaction. Heavier than the built-in browser tool but more capable for site-specific automation.',
    icon: '🤖',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    setupSteps: [
      'First run downloads Chromium (~120 MB). Be patient — connection timeout is 60s, but first install can be slower.',
    ],
  },
  {
    id: 'slack',
    defaultServerId: 'slack',
    displayName: 'Slack',
    description: 'Read channels, post messages, list users — anything the Slack API lets a bot do.',
    icon: '💬',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnv: [
      { key: 'SLACK_BOT_TOKEN', label: 'Slack bot token', hint: 'Starts with xoxb-. Create a Slack app at api.slack.com/apps and grab the Bot User OAuth Token.', placeholder: 'xoxb-...' },
      { key: 'SLACK_TEAM_ID',   label: 'Slack team ID',  hint: 'Workspace id, starts with T. Visible in your workspace URL or via api.slack.com/methods/team.info.', placeholder: 'T...' },
    ],
  },
];

export function getCatalog() {
  return CATALOG;
}

export function getCatalogEntry(id) {
  return CATALOG.find(e => e.id === id) ?? null;
}
