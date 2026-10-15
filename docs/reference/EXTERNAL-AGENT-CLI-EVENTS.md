# CLI externos: eventos e integración futura

Fecha de revisión: 7 de octubre de 2026.

Estado: investigación del 7 de octubre de 2026. El menú lanza el TUI original de Codex, Claude Code, Grok, Antigravity CLI (`agy`) y Muse Code, con un hook observacional que alimenta el mismo reductor de actividad. No es soporte completo: no hay una prueba con un prompt real, y Termina no restaura ni bifurca esas sesiones. Los contratos consultados son [Codex](https://developers.openai.com/codex/hooks), [Claude Code](https://code.claude.com/docs/en/hooks), [Grok](https://docs.x.ai/build/features/hooks), [Antigravity CLI](https://antigravity.google/docs/hooks/) y [Muse Code](https://dev.meta.ai/docs/muse-code/extending). Esta nota no cambia las reglas de [AGENTS.md](../../AGENTS.md).

## Diagnóstico de eventos (15 de octubre de 2026)

Esta sección actualiza el diagnóstico de runtime; las secciones de investigación siguientes conservan el alcance de la revisión original.

- Los hooks se instalan al abrir el CLI desde el menú de Termina o al crear una terminal shell de Termina. El proceso recibe la conexión y una identidad de terminal y generación por entorno. Un CLI iniciado fuera de Termina no recibe esa conexión. Una terminal creada sin ese entorno necesita una nueva sesión de terminal para recibirlo.
- Codex requiere revisar y confiar en la definición exacta de los hooks mediante `/hooks`. Los hooks nuevos o modificados se omiten hasta recibir confianza. Termina no usa `--dangerously-bypass-hook-trust`. Véase [Review and trust hooks](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
- Se corrigió una pérdida de actividad en el resumen de proyecto: los CLI externos son terminales de tipo shell, y el resumen descartaba su actividad incluso cuando el hook ya había llegado al reductor. Ahora conserva la actividad observada para los contadores de trabajo y atención. Una shell sin actividad observada sigue siendo desconocida; no obtiene capacidades de verificación o sesión del motor propio.
- El transporte observacional actual alimenta actividad y permisos documentados, no entradas de herramientas en Session Timeline, snapshots ni atribución de ediciones en Change Review. Los cambios de archivos siguen pasando por el watcher. La ausencia de esas entradas no demuestra que falten hooks.

La prueba [external-cli-events.spec.ts](../../tests/e2e/external-cli-events.spec.ts) ejecuta los comandos de hooks instalados por main para Codex, Claude, Grok, Antigravity y Muse desde un PTY real, con HOME y configuración aislados. Comprueba recepción en la terminal, contadores de proyecto y permisos donde están configurados. No ejecuta los CLI de terceros ni prompts con modelos, por lo que no certifica su emisión real, autenticación, confianza o cobertura de eventos. Los contratos de configuración y confianza consultados son [Codex](https://learn.chatgpt.com/docs/hooks) y [Antigravity](https://antigravity.google/docs/hooks/).

## Objetivo de producto

Permitir que la gente use Gemini CLI, Grok Build, Claude Code, Codex y otros CLI de agentes dentro de Termina, con su interfaz de terminal original a la izquierda y Monaco, el explorador y la revisión de archivos a la derecha. El usuario debe poder elegir el CLI y conservar su autenticación, configuración e instrucciones propias.

Usar un modelo de Google, xAI, Anthropic u OpenAI mediante `agent-core` es una capacidad distinta de ejecutar el CLI de ese proveedor. El objetivo futuro incluye los programas originales y su experiencia de uso.

La lista de CLI es abierta. Cada integración debe declarar y comprobar las capacidades que realmente ofrece: actividad, atención, herramientas, archivos y, por separado, restauración de conversaciones. Un CLI ejecutable en una terminal puede carecer de eventos suficientes para alguna de esas funciones.

## Qué hace Termina actualmente

| Responsabilidad | Comportamiento actual | Propietario |
| --- | --- | --- |
| Lanzamiento de agentes | El único motor admitido es `core`; las terminales shell pueden ejecutar otros programas. | [electron/main.ts](../../electron/main.ts), creación de terminales |
| Eventos del agente | Consume `agent_start`, `agent_settled`, `tool`, `tool_end` y eventos de admisión, checkpoints y sesión del motor propio. | [electron/sidecar/events.ts](../../electron/sidecar/events.ts), [electron/sidecar.ts](../../electron/sidecar.ts) |
| Estado y avisos | Calcula `idle`, `working` y `blocked`; la UI emite avisos y sonido al cambiar a idle o blocked, según el foco. No deduce el estado del texto del PTY. | [electron/agent-activity.ts](../../electron/agent-activity.ts), [src/activity-cue.ts](../../src/activity-cue.ts), [src/main.ts](../../src/main.ts) |
| Cambios reales de archivos | Observa el disco, incluidas escrituras hechas por herramientas, scripts y procesos externos; main publica `file:changed` y `file:deleted`. | [electron/watcher.ts](../../electron/watcher.ts), [electron/main.ts](../../electron/main.ts) |

`blocked` se deriva de hechos como fallos repetidos, un agente detenido por falta de progreso, espera de admisión o salida durante un run. El contrato actual de actividad no tiene señales explícitas para una pregunta al usuario o una aprobación pendiente de un CLI externo.

Abrir uno de esos CLI desde una terminal shell no lo conecta automáticamente con las notificaciones de agente, la atribución de herramientas ni las sesiones de `agent-core`. El watcher puede observar cambios en disco, pero observar un cambio no prueba qué agente lo produjo ni autoriza acciones de revisión o revert. Véase [Concurrent sessions](SESSION-CONCURRENCY.md).

## Eventos similares documentados

La tabla compara hooks, que permiten observar eventos mientras se conserva la interfaz del CLI. Los nombres parecidos no garantizan el mismo esquema, orden, cobertura o significado.

| Señal | [Codex](https://learn.chatgpt.com/docs/hooks) | [Claude Code](https://code.claude.com/docs/en/hooks) | [Grok Build](https://docs.x.ai/build/features/hooks) | [Antigravity CLI](https://antigravity.google/docs/hooks/) |
| --- | --- | --- | --- | --- |
| Prompt recibido | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` | `PreInvocation` |
| Fin de respuesta | `Stop` | `Stop` | `Stop` | `Stop` |
| Herramienta por ejecutar | `PreToolUse` | `PreToolUse` | `PreToolUse` | `PreToolUse` |
| Herramienta ejecutada | `PostToolUse` | `PostToolUse`, `PostToolUseFailure` | `PostToolUse`, `PostToolUseFailure` | `PostToolUse`, con `error` cuando la herramienta falla |
| Solicitud de permiso | `PermissionRequest` | `PermissionRequest` | No figura como hook en la lista consultada | No figura como hook en la lista consultada |
| Aviso del CLI | No figura `Notification` en la lista consultada | `Notification` | `Notification` | No figura `Notification` en la lista consultada |
| Ciclo de sesión | `SessionStart`, `SessionEnd` | `SessionStart`, `SessionEnd` | `SessionStart`, `SessionEnd` | `SessionStart` |
| Ciclo de subagente | `SubagentStart`, `SubagentStop` | `SubagentStart`, `SubagentStop` | `SubagentStart`, `SubagentStop` | No figura en la referencia de hooks consultada |

### Codex

`PostToolUse` observa `apply_patch`; los matchers `Edit` y `Write` también lo aceptan, aunque el payload conserva `tool_name: "apply_patch"`. Para Bash también se ejecuta tras un exit no cero. Hooks externos requieren revisión y confianza. [Hooks de Codex](https://learn.chatgpt.com/docs/hooks).

App-server expone `turn/started`, `turn/completed`, `item/started`, `item/completed`, elementos `fileChange` con rutas y diffs, y `turn/diff/updated`. El fin del turno distingue `completed`, `failed` e `interrupted`. Aprobaciones y preguntas son solicitudes al cliente. La documentación también permite conectar el TUI mediante `codex --remote` a app-server; lo marca experimental. Es una alternativa que requiere evaluación, no soporte actual de Termina. [Codex app-server](https://learn.chatgpt.com/docs/app-server).

### Claude Code

`PermissionRequest` observa la solicitud inmediata. `Notification` puede avisar con retraso; `idle_prompt` espera aproximadamente 60 segundos. `Stop` no cubre interrupciones del usuario; errores de API tienen `StopFailure`. `FileChanged` observa archivos configurados, incluidos cambios de Bash y procesos externos. `PostToolUse` filtrado por `Edit|Write` solo cubre esas herramientas. [Hooks de Claude Code](https://code.claude.com/docs/en/hooks).

### Grok Build

Los hooks aceptan comandos o HTTP y usan campos camelCase: `hookEventName`, `sessionId`, `toolName`, `toolInput`. Los hooks de proyecto requieren confianza. La referencia confirma `Notification`, pero no detalla sus tipos ni documenta un hook `PermissionRequest`; no debe asumirse paridad completa con Claude por compatibilidad de configuración. [Hooks de Grok](https://docs.x.ai/build/features/hooks).

Grok documenta ACP con `grok agent stdio`. ACP define `session/request_permission`, actualizaciones de herramientas y el resultado de `session/prompt` con `stopReason`. Esa ruta permite estudiar permisos explícitos; su cobertura concreta en Grok sigue pendiente de prueba. [Grok headless y ACP](https://docs.x.ai/build/cli/headless-scripting), [herramientas ACP](https://agentclientprotocol.com/protocol/v1/tool-calls), [turnos ACP](https://agentclientprotocol.com/protocol/v1/prompt-turn).

### Antigravity CLI (`agy`)

El comando es `agy`. Los hooks globales viven en `~/.gemini/config/hooks.json`. `PreInvocation` ocurre antes de cada llamada al modelo. `PreToolUse` y `PostToolUse` traen `toolCall.name` y `stepIdx`; `PostToolUse` incluye `error` cuando la herramienta falla. `Stop` cierra el ciclo. La referencia consultada no documenta un hook de permiso. [Hooks de Antigravity](https://antigravity.google/docs/hooks/).

## Salidas estructuradas alternativas

| CLI | Canal documentado | Uso y límite |
| --- | --- | --- |
| Codex | `codex exec --json`; app-server | JSONL con `turn.started`, `turn.completed`, `turn.failed` e `item.*`; app-server ofrece conversación y solicitudes al cliente. [Modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode), [app-server](https://learn.chatgpt.com/docs/app-server) |
| Claude Code | `claude -p --output-format stream-json --verbose` | Salida de print mode; `--include-hook-events` añade eventos de hooks, con excepciones documentadas. No es el TUI interactivo. [Referencia CLI](https://code.claude.com/docs/en/cli-reference) |
| Grok Build | `grok -p "…" --output-format streaming-json`; `grok agent stdio` | NDJSON en headless o JSON-RPC por ACP. La ayuda local identifica streaming-json como actualizaciones ACP. [Headless y scripting](https://docs.x.ai/build/cli/headless-scripting) |
| Antigravity CLI | TUI `agy` | Hooks observacionales en `~/.gemini/config/hooks.json`. [Hooks](https://antigravity.google/docs/hooks/) |

Headless y ACP cambian quién presenta la conversación y recibe la entrada. No debe sustituirse silenciosamente el CLI interactivo por una interfaz propia para obtener eventos. La ruta inicial a estudiar para el objetivo de producto es PTY original más hooks observacionales y el watcher existente. Donde los hooks no basten, documentar la capacidad ausente y evaluar el protocolo del proveedor.

## Qué debe significar cada señal en Termina

Estas son condiciones para una implementación futura, no nuevos eventos ya disponibles.

| Hecho recibido | Interpretación requerida |
| --- | --- |
| Prompt enviado | Intención de empezar. Todavía puede fallar la admisión o un hook. No equivale al `agent_start` admitido de Termina. |
| Inicio de sesión | El CLI abrió o restauró una conversación. No implica un run activo. |
| Inicio de trabajo admitido | Puede pasar a working y establecer el alcance de escritura mediante el propietario actual de admisión. |
| Permiso o pregunta pendiente | Atención por espera del usuario. Registrar el motivo y su resolución; distinguirlo de un fallo repetido de herramientas. |
| Fin de respuesta | Puede indicar idle, pero conservar éxito, error, interrupción o resultado desconocido cuando el canal lo permita. No prueba que la tarea esté completada o verificada. |
| Herramienta de edición iniciada | Intención de modificar una ruta. No prueba que el archivo se haya escrito. |
| Herramienta terminada y cambio observado | Correlacionar resultado y archivo sin duplicar la entrada ni inventar contenido anterior. |
| Stream perdido o proceso cerrado durante el run | Conservar la incertidumbre o el fallo. El silencio y los bytes del PTY no son evidencia de éxito. |

`Stop` puede preceder una continuación solicitada por otro hook. La integración debe comprobar cómo distinguir ese intento de cierre del cierre definitivo; un temporizador arbitrario no demuestra que el run haya terminado. En un canal que no permita probarlo, la UI debe expresar esa limitación.

Los payloads requieren traducción. Codex y Claude usan campos como `session_id`, `hook_event_name` y `tool_use_id`; Grok documenta camelCase; Gemini tiene su propio esquema. IDs del proveedor, IDs de terminal, generaciones y runs de Termina tienen responsabilidades distintas. No deben mezclarse ni sintetizarse entradas de sesión o IDs de snapshots que el proveedor no produjo.

## Integración con los propietarios existentes

Main debe elegir y lanzar el CLI, validar los mensajes y asociarlos al proyecto, workspace, terminal y generación correctos. [terminal-runtime.ts](../../electron/terminal-runtime.ts) sigue siendo el propietario del ciclo del PTY y sus viewers. Los adaptadores de formatos alimentan el único reductor de actividad, [agent-activity.ts](../../electron/agent-activity.ts); cada CLI no necesita su propio sistema de notificaciones.

El watcher sigue siendo la autoridad sobre bytes en disco. Los eventos de herramientas añaden intención, ruta y resultado cuando estén disponibles. Los cambios de scripts, renombres, borrados y archivos binarios deben seguir pasando por el propietario existente. Un aviso del CLI no reemplaza los baselines ni las comprobaciones de atribución y actualidad de Change Review.

El contrato actual de sidecar también controla admisión y checkpoints. No basta renombrar un hook como `agent_start` o escribir JSONL con la misma forma para obtener sus garantías. Si se usa ese transporte, hay que extender su propietario y escritores autorizados de forma explícita, manteniendo límites, validación, orden y cercas de generación. No crear un segundo tailer, un segundo contrato de actividad ni un escritor externo sin esas garantías.

Los CLI externos deben entrar en la política existente de escritura y aislamiento antes de poder modificar un árbol. Un hook que llega después de una escritura no puede conceder retroactivamente una write lease. Si un CLI no permite admisión por turno, estudiar una admisión conservadora por vida del proceso; la decisión debe preservar exclusión de escritores, limpieza y responsiveness de main. Los sandboxes y la sanitización del entorno siguen bajo los propietarios actuales, incluido retirar `PI_*` de procesos hijos.

Renderer conserva el puente tipado de preload. No debe ejecutar CLI, leer directamente sus archivos de sesión ni decidir permisos de filesystem. Los handlers observacionales deben ser pequeños y respetar el contrato de salida del proveedor, sin aprobar herramientas, inyectar instrucciones o cambiar decisiones de otros hooks. Incorporar hooks debe conservar los del usuario y respetar el mecanismo de confianza del CLI.

Restaurar un CLI o hacer fork de su conversación requiere un contrato propio del proveedor y pruebas. Los archivos de sesión externos no son bundles de `agent-core`. Snapshots y operaciones Git siguen en Rust mediante [worldline-git.ts](../../electron/worldline-git.ts); forks de sesión siguen en [session-fork.ts](../../electron/session-fork.ts) y su worker. Tener eventos de edición no habilita automáticamente Worldlines, promoción, replay o dispatch para ese CLI.

## Próximo trabajo propuesto

1. Elegir un CLI para una prueba de integración completa: lanzamiento con TUI original, admisión de escritura, eventos de trabajo y atención, archivos en Monaco y cierre seguro.
2. Capturar eventos reales en un entorno aislado y fijar la versión probada. Resolver los huecos de fin definitivo, permisos y correlación antes de declarar soporte.
3. Extender los propietarios existentes solo para esas capacidades demostradas. Añadir el siguiente CLI reutilizando el contrato, sin copiar orquestación o reglas de actividad.
4. Evaluar restauración de conversaciones y operaciones avanzadas de Termina como trabajo separado, con capacidades visibles y verificadas por CLI.

No se propone instalar automáticamente CLI, crear un catálogo de plugins ni convertir sus sesiones a nuestro formato. Esas decisiones necesitan requisitos concretos.

## Cómo demostrar una integración futura

| Caso | Evidencia esperada |
| --- | --- |
| Abrir el CLI elegido | Interfaz original operable; auth y configuración correctas; terminal asociada al workspace correcto. |
| Prompt rechazado o admitido | Ningún rechazo queda marcado como trabajo activo; el trabajo admitido respeta exclusión de escritores. |
| Fin normal, error, interrupción y continuación por hook | Señales distinguibles, sin avisar éxito por un intento de Stop ni por cierre de proceso. |
| Permiso o pregunta | Aviso dirigido a la terminal correcta; resolver la espera actualiza actividad sin conceder permisos desde un hook observador. |
| Editar con herramienta o script | Monaco observa los bytes reales; rutas, borrados y renombres no duplican cambios ni fabrican baselines. |
| Hooks ausentes, deshabilitados, no confiables o fallidos | Capacidad limitada reconocible; ausencia de eventos no se presenta como prueba de idle o éxito. |
| Dos agentes y proyectos distintos | Identidad, generación y leases impiden cruzar avisos o atribuir cambios al agente equivocado. |
| Cierre, crash y eventos tardíos | Limpieza de recursos propios y rechazo de eventos de generaciones anteriores. |
| Subagente externo | Su cierre no termina el run del padre; cobertura limitada si falta identidad o evento. |

Para cambios de runtime, aplicar typecheck, unit tests relevantes, build y E2E de Electron conforme a [AGENTS.md](../../AGENTS.md). Las pruebas usan los roots aislados de [tests/e2e/fixtures.ts](../../tests/e2e/fixtures.ts), sin ejecutar sesiones contra el árbol de agente del host.

## Evidencia y límites de esta revisión

| CLI | Comprobación local |
| --- | --- |
| Codex | `codex-cli 0.155.1`; ayuda de CLI, exec y app-server; `hooks` figura estable y habilitado en `codex features list`. |
| Claude Code | `2.1.292`; ayuda local confirma print mode, stream-json e inclusión de eventos de hooks. |
| Grok Build | `1.0.44`, stable; ayuda local confirma streaming-json y ACP. Se deshabilitó el auto-update para estas consultas. |
| Gemini | Antigravity CLI, comando `agy`. Hooks en `~/.gemini/config/hooks.json` ([Hooks](https://antigravity.google/docs/hooks/)). |

Las páginas oficiales se consultaron en la fecha indicada. Pueden describir una versión más reciente que la instalada; esta nota no fija una versión mínima de soporte. La definición de ACP es evidencia del protocolo, no una prueba de que un CLI emita todas sus variantes.

Se revisó código estáticamente y se ejecutaron únicamente consultas de versión y ayuda de CLI. Esta tarea modifica documentación e índice; se comprueban enlaces locales, referencias a comandos y formato del diff. No se ejecutaron prompts con modelos, hooks configurados, pruebas de aplicación ni build. El objetivo futuro queda documentado; la integración y su validación siguen pendientes.
