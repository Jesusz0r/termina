"""Harbor adapter for Termina's headless agent-core."""

from pathlib import Path, PurePosixPath
import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class TerminaAgent(BaseInstalledAgent):
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    _REMOTE_ROOT = PurePosixPath("/opt/termina")
    _OUTPUT_FILENAME = "termina.txt"

    def __init__(self, *args, auth_path: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._source_dir = Path(__file__).resolve().parents[2] / "agent-core"
        self._auth_path = Path(auth_path).expanduser() if auth_path else Path.home() / ".termina/agent/auth.json"

    @staticmethod
    @override
    def name() -> str:
        return "termina"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._source_dir.is_dir():
            raise FileNotFoundError(f"Termina agent-core source not found: {self._source_dir}")
        if not self._auth_path.is_file():
            raise FileNotFoundError(
                f"Termina auth file not found: {self._auth_path}. Sign in from Termina first."
            )

        await self.ensure_system_dependencies(environment, ("curl", "bash", "ripgrep"))
        await self.exec_as_agent(
            environment,
            command=f"set -euo pipefail; {nvm_node_install_snippet()} && node --version",
        )
        await self.exec_as_root(
            environment,
            command=f"rm -rf {self._REMOTE_ROOT} && mkdir -p {self._REMOTE_ROOT}/agent-core",
        )
        await environment.upload_dir(
            self._source_dir, (self._REMOTE_ROOT / "agent-core").as_posix()
        )

        home_result = await self.exec_as_agent(environment, command='printf %s "$HOME"')
        remote_home = (home_result.stdout or "").strip()
        if home_result.return_code != 0 or not remote_home.startswith("/"):
            raise RuntimeError("Could not resolve the sandbox agent home directory")
        remote_auth = f"{remote_home}/.termina/agent/auth.json"
        await self.exec_as_agent(
            environment,
            command="mkdir -p $HOME/.termina/agent && chmod 700 $HOME/.termina $HOME/.termina/agent",
        )
        await self._upload_agent_owned_file(environment, self._auth_path, remote_auth)
        await self.exec_as_agent(
            environment,
            command=f"chmod 600 {shlex.quote(remote_auth)}",
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model must be provider/model, e.g. openai-codex/gpt-5.4")
        provider, model = self.model_name.split("/", 1)
        env = {
            "TERMINA_CORE_PROVIDER": provider,
            "TERMINA_CORE_MODEL": model,
            "TERMINA_CORE_EFFORT": "high",
            "TERMINA_EVENTS_DIR": "/tmp/termina-events",
            "TERMINA_TERMINAL_ID": "harbor",
        }
        command = (
            "set -o pipefail; "
            f"node --experimental-strip-types --no-warnings {self._REMOTE_ROOT}/agent-core/main.ts "
            f"--print {shlex.quote(instruction)} </dev/null 2>&1 | "
            f"tee /logs/agent/{self._OUTPUT_FILENAME}"
        )
        await self.exec_as_agent(environment, command=command, env=env, cwd="/app")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        # Termina writes detailed token/cache/cost traces; Harbor retains stdout here.
        output = self.logs_dir / self._OUTPUT_FILENAME
        if output.exists():
            context.metadata = {
                **(context.metadata or {}),
                "termina_output": self._OUTPUT_FILENAME,
            }
