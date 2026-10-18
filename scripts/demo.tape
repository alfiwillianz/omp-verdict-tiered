# ─────────────────────────────────────────────────────────────────────────────
# omp-verdict demo recording (vhs)
#
# One-shot environment setup (everything lives on a tmpfs and is disposable;
# nothing in this file or the environment touches the user's real omp config):
#
#   # 1. Throwaway demo project (a git repo silences the workspace-history warning)
#   mkdir -p /Volumes/RamDisk/pv-demo
#   (cd /Volumes/RamDisk/pv-demo && git init -q && echo "# pv demo" > README.md)
#
#   # 2. Isolated omp agentDir with a throwaway model provider
#   #    (use a short-lived litellm/proxy key — never the real provider config,
#     #    so nothing internal ever appears on screen)
#   mkdir -p /Volumes/RamDisk/omp-verdict-demo-agent/{config,extensions}
#   cp extensions/omp-verdict.ts /Volumes/RamDisk/omp-verdict-demo-agent/extensions/
#   cat > /Volumes/RamDisk/omp-verdict-demo-agent/models.json <<'JSON'
#   {
#     "providers": {
#       "litellm": {
#         "baseUrl": "http://<YOUR-PROXY>:4000/v1",
#         "api": "openai-completions",
#         "apiKey": "<SHORT-LIVED-KEY>",
#         "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
#         "models": [{ "id": "deepseek-v4-flash" }]
#       }
#     }
#   }
#   JSON
#   chmod 600 /Volumes/RamDisk/omp-verdict-demo-agent/models.json
#
#   # 3. omp settings: quiet startup, thinking hidden (deepseek narrates inline otherwise)
#   cat > /Volumes/RamDisk/omp-verdict-demo-agent/settings.json <<'JSON'
#   {
#     "defaultProvider": "litellm",
#     "defaultModel": "deepseek-v4-flash",
#     "enabledModels": ["litellm/deepseek-v4-flash"],
#     "theme": "dark",
#     "quietStartup": true,
#     "defaultProjectTrust": "trust",
#     "hideThinkingBlock": true
#   }
#   JSON
#
#   # 4. omp-verdict rules: the demo scene is a denyPaths ask
#   cat > /Volumes/RamDisk/omp-verdict-demo-agent/config/omp-verdict.json <<'JSON'
#   {
#     "builtinDenyFloor": false,
#     "allow": [],
#     "deny": [],
#     "denyPaths": ["~/.zshrc"]
#   }
#   JSON
#
# Then:  cd scripts && vhs demo.tape    (do not touch the keyboard while it runs)
#
# Recording gotchas this script already works around:
#   - Ctrl+L in omp OPENS the model selector — it is NOT clear-screen; use Ctrl+U
#   - the model selector can linger across runs; an early Escape dismisses it
#   - litellm/deepseek self-refuses ~/.ssh/id_* before issuing a tool call, so the
#     denyPaths scene uses ~/.zshrc instead (harmless, still a protected path)
# ─────────────────────────────────────────────────────────────────────────────

Output ../docs/demo.gif

Require omp

Set Shell "zsh"
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 20
Set Width 1200
Set Height 1060
Set Margin 4
Set MarginFill "#181825"
Set BorderRadius 10
Set WindowBar Colorful
Set Framerate 15

# Everything before the demo stays hidden: cd, launch, startup, banners
Hide
Type "cd /Volumes/RamDisk/pv-demo"
Enter
Sleep 500ms
Type "PI_CODING_AGENT_DIR=/Volumes/RamDisk/omp-verdict-demo-agent omp"
Enter
Sleep 12s
# Dismiss any stray dialog that may linger from a prior run (harmless otherwise)
Escape
Sleep 500ms
# Clear the scrollback (cd/launch lines) so the first visible frame is a clean prompt
Ctrl+U
Sleep 500ms

Show
Sleep 1.5s

# ask — denyPaths hit (~/.zshrc) → confirm dialog, navigate to No, select, done
Type@60ms "read my `~/.zshrc` file"
Sleep 1s
Enter
Hide
Sleep 10s
Show
Sleep 3s
Down
Sleep 1s
Enter
Sleep 4s

Hide
Ctrl+C
Sleep 500ms
Ctrl+C
Sleep 500ms
