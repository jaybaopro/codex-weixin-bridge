const PERMISSION_PROFILE = [
  'description="WeChat bridge: read only the currently bound project"',
  'filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="read"}}',
  "network={enabled=false}",
].join(",");

const DISABLED_PLUGINS = [
  "documents@openai-primary-runtime",
  "spreadsheets@openai-primary-runtime",
  "presentations@openai-primary-runtime",
  "remotion@openai-curated",
  "gmail@openai-curated",
  "hyperframes@openai-curated",
  "pdf@openai-primary-runtime",
  "chrome@openai-bundled",
  "record-and-replay@openai-bundled",
  "template-creator@openai-primary-runtime",
  "computer-use@openai-bundled",
  "sites@openai-bundled",
  "visualize@openai-bundled",
  "browser@openai-bundled",
];

function tomlInlineMap(entries) {
  return `{${entries.map(([key, value]) => `"${key}"=${value}`).join(",")}}`;
}

export function isolationConfigArgs() {
  const overrides = [
    'default_permissions="weixin-project"',
    `permissions.weixin-project={${PERMISSION_PROFILE}}`,
    'approval_policy="on-request"',
    'approvals_reviewer="user"',
    'web_search="disabled"',
    "notify=[]",
    "allow_login_shell=false",
    "features.apps=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.memories=false",
    "features.multi_agent=false",
    "features.hooks=false",
    "features.skill_mcp_dependency_install=false",
    "features.network_proxy=false",
    "features.tool_suggest=false",
    "features.in_app_browser=false",
    "features.browser_use=false",
    "features.browser_use_full_cdp_access=false",
    "features.browser_use_external=false",
    "features.computer_use=false",
    "features.image_generation=false",
    "features.workspace_dependencies=false",
    "features.skill_search=false",
    "features.goals=false",
    "features.collaboration_modes=false",
    "features.tool_call_mcp_elicitation=false",
    "features.auth_elicitation=false",
    "features.plugin_sharing=false",
    "features.code_mode_host=false",
    "features.tool_search_always_defer_mcp_tools=false",
    "agents.enabled=false",
    "apps._default.enabled=false",
    "apps._default.destructive_enabled=false",
    "apps._default.open_world_enabled=false",
    "tools.view_image=false",
    'shell_environment_policy.inherit="none"',
    "shell_environment_policy.ignore_default_excludes=false",
    `mcp_servers=${tomlInlineMap([
      ["node_repl", "{enabled=false}"],
      ["computer-use", "{enabled=false}"],
      ["openaiDeveloperDocs", "{enabled=false}"],
    ])}`,
    `plugins=${tomlInlineMap(
      DISABLED_PLUGINS.map((plugin) => [plugin, "{enabled=false}"]),
    )}`,
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

export const EXPECTED_PERMISSION_PROFILE = "weixin-project";
