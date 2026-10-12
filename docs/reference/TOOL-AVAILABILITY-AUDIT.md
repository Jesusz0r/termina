# Herramientas disponibles y autorizadas en Termina

Fecha: 7 de octubre de 2026.

Estado: auditoría del 7 de octubre de 2026, con una decisión de prefijo aplicada el 12 de octubre de 2026. La política única vive en `agent-core/tool-eligibility.ts`. Un turno `/plan` rechaza las llamadas que el executor no va a ejecutar y no altera el prefijo de esquemas: la petición siguiente de la misma sesión sigue viendo las herramientas congeladas. P1 no admite cambiar ese conjunto a mitad de sesión ni crear una sesión nueva automáticamente. Bash que necesita aprobación sigue anunciado. Los adaptadores MCP se anuncian solo cuando hay catálogo. El resto del filtrado por tarea sigue fuera de esta decisión.

Código revisado: `2b468678591c58159df6b6ea6cf49b6c7294fba5`. No había cambios en archivos rastreados durante esta revisión. Se conservó el directorio `.worktrees/` sin seguimiento.

Termina filtra algunas herramientas según el proveedor, el tipo de agente y las conexiones disponibles. Todavía no tiene una selección general que anuncie al modelo únicamente las herramientas elegibles para cada tarea. En algunos casos anuncia una herramienta y rechaza su ejecución después.

## Qué hace actualmente

| Caso | Declaración al modelo | Control al ejecutar | Propietario |
| --- | --- | --- | --- |
| Herramientas básicas | `clientTools` parte del catálogo `TOOLS`, que incluye lectura, escritura, edición, búsqueda, bash y fetch. | Valida la herramienta, sus argumentos y las restricciones de la operación. | `agent-core/main.ts`: `TOOLS`, `callModel`, `executeTool`; `agent-core/tool-dispatch.ts` |
| Agentes hijos | `visibleSubagentTools` omite todas las herramientas de subagentes cuando alcanza la profundidad máxima. | Mantiene la validación de profundidad y los controles del host. | `agent-core/subagents.ts`: `visibleSubagentTools`; integración en `agent-core/main.ts` |
| Candidatos Worldline | Omite `spawn_subagent` del catálogo. | También rechaza el intento de creación si llega una llamada. | `agent-core/main.ts`: construcción de `TOOLS` y `executeTool` |
| Búsqueda web nativa | `requestTools` añade `web_search` únicamente para el proveedor Anthropic. | La habilitación real de esa función en la cuenta depende del proveedor. La selección local por proveedor no comprueba por sí sola esa habilitación. | `agent-core/main.ts`: `requestTools` |
| MCP | Anuncia `search_mcp_tools` y `call_mcp_tool` cuando el catálogo contiene herramientas. Los esquemas concretos se recuperan bajo demanda. | Llama mediante la sesión MCP existente, con sus controles de transporte, resultados y cancelación. | `agent-core/mcp/discovery.ts` y `agent-core/mcp/client.ts` |
| `/plan` | Conserva el catálogo básico, incluidas herramientas de escritura. | `executeTool` admite solo `READ_TOOLS` y `search_mcp_tools`. Rechaza escritura, bash y llamadas MCP. | `agent-core/main.ts`: `planToolsRestricted`; `agent-core/tool-dispatch.ts`: `READ_TOOLS` |
| Permisos de bash | `bash` permanece anunciado. | `confirmBashNow` decide si el comando necesita aprobación según la política y obtiene la respuesta antes de ejecutarlo. | `agent-core/main.ts`: `confirmBashNow` |

La conexión MCP produce un catálogo de herramientas tras el handshake. Los servidores fallidos o que necesitan autenticación no aportan herramientas en esa fase. Esto no garantiza que una conexión siga disponible cuando llegue una llamada posterior.

La carga diferida de esquemas MCP reduce el catálogo enviado en el prefijo. No equivale a autorizar todas las acciones que esas herramientas pueden realizar. Las anotaciones MCP tampoco establecen por sí solas que una acción sea de lectura.

## Mejora propuesta

La propuesta es filtrar antes de construir la petición del modelo las herramientas que el contexto actual prohíbe de forma determinista o que el host no ofrece. El primer caso concreto para estudiar es `/plan`: evitar anunciar herramientas que el executor ya sabe que rechazará durante esa tarea.

Una herramienta que puede ejecutarse tras aprobación debe distinguirse de una herramienta prohibida. Por ejemplo, necesitar confirmación para un comando bash no convierte automáticamente a `bash` en una herramienta indisponible. La aprobación depende de la acción concreta y debe seguir resolviéndose en el propietario actual.

La implementación futura debería cumplir estas condiciones:

1. Usar una sola política para decidir la elegibilidad de las herramientas. La selección de declaraciones y la admisión de llamadas deben consultar esa política, sin mantener listas de reglas independientes.
2. Mantener las comprobaciones al ejecutar. Un catálogo anunciado anteriormente no autoriza una acción cuando cambia la disponibilidad, llega Stop o existe una restricción del host.
3. Aplicar la misma selección a las peticiones de todos los proveedores y al cálculo de tokens de esquemas.
4. Mantener el descubrimiento MCP bajo demanda y sus límites existentes. La propuesta no necesita otro catálogo, sistema de plugins o editor del harness.
5. Preservar resultados y registros de llamadas que ya ocurrieron. Un cambio de selección no debe reescribir historia ni eliminar pares de llamadas y resultados.

La estabilidad del prefijo necesita una decisión de diseño antes de implementar el filtrado por tarea. [AGENT-CORE.md](AGENT-CORE.md) establece en P1 que los esquemas no cambian durante una sesión y que un cambio del conjunto de herramientas requiere una sesión nueva. El filtrado propuesto para `/plan` y la posterior implementación no debe modificar silenciosamente ese contrato ni crear sesiones automáticamente. Esta auditoría identifica la cuestión; no aprueba una excepción a P1.

## Cómo comprobar una implementación futura

| Caso | Resultado esperado |
| --- | --- |
| Tarea de planificación | Las declaraciones coinciden con las herramientas de lectura y descubrimiento permitidas. Una llamada de escritura inyectada sigue rechazándose. |
| Tarea de implementación | Incluye las herramientas elegibles para realizar cambios y conserva las aprobaciones de acciones concretas. |
| Agente hijo o candidato Worldline | Conserva los filtros y rechazos actuales de creación de subagentes. |
| MCP sin catálogo disponible | No anuncia los dos adaptadores de descubrimiento y ejecución. |
| MCP conectado | Anuncia los adaptadores sin cargar todos los esquemas concretos en el prefijo. |
| Pérdida de disponibilidad o Stop | Rechaza nuevas acciones sin confiar en declaraciones anteriores. |
| Varias iteraciones y reintentos | Respeta la política acordada de estabilidad del prefijo y conserva las secuencias válidas de herramientas. |
| Cambio de proveedor | Aplica la selección a cada constructor de peticiones y conserva la selección específica de búsqueda web nativa. |

Medir llamadas rechazadas por restricciones conocidas, bytes de esquemas enviados y resultados de tareas representativas. Cualquier afirmación de ahorro de tokens, latencia o coste requiere medición; el filtrado por sí solo no demuestra una mejora.

## Referencias y límites de esta revisión

- [Declaraciones, peticiones y ejecución](../../agent-core/main.ts): `TOOLS`, `clientTools`, `requestTools`, `callModel`, `executeTool` y `confirmBashNow`.
- [Herramientas observacionales y validación](../../agent-core/tool-dispatch.ts): `READ_TOOLS` y contratos de despacho.
- [Selección de herramientas de subagentes](../../agent-core/subagents.ts): `visibleSubagentTools`.
- [Descubrimiento MCP](../../agent-core/mcp/discovery.ts): `mcpClientTools`, `searchMcpTools` y `callDiscoveredMcpTool`.
- [Conexiones MCP](../../agent-core/mcp/client.ts): catálogo obtenido mediante handshake y estados de conexión.
- [Referencia de agent-core](AGENT-CORE.md): prefijos estables y descubrimiento diferido.

Las conclusiones sobre el comportamiento actual proceden de lectura estática del código. Esta tarea solo crea documentación; no cambia el runtime ni certifica disponibilidad de proveedores. Se comprobaron las referencias locales, los comandos citados contra el manifiesto y el formato del diff. No se ejecutaron modelos reales, tests de aplicación, build ni pruebas de Electron porque no se modificó código.
