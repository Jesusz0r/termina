# Termina: replanteamiento terminal-first de UI, UX y Dev UX

**Fecha:** 2026-10-08. **Base inspeccionada:** `feature/attention-workspace-overview`, commit `6e839c36`. **Estado:** auditoría del núcleo de interacción y seguimiento de implementación local. Las secciones 1–16 describen la base inspeccionada antes de cambios de producto y conservan sus hipótesis. La regla de entrada fue confirmada por el usuario; la simplificación de presentación autorizada posteriormente está implementada y verificada en la sección 20. Las demás recomendaciones no implican cambios de producto. Las secciones 17–19 registran el contrato de intervención, su integración con la entrada a proyectos y su verificación. La sección 20 registra la simplificación de presentación autorizada después: retirar Project work, unificar el destino de terminal y abrir herramientas bajo demanda. Este documento no acredita pruebas de usabilidad ni mejoras medidas.

## Estado posterior: retirada de All projects y Overview

El usuario autorizó después retirar **All projects**, el overview global,
**Project details**, el inspector y el composer, incluidos **Create task** /
**Start task** exclusivos de Overview y los IPC privilegiados `plan:create` /
`plan:start`. **Attention** es ahora una sección permanente del rail por encima
de **Projects**, con un encabezado no interactivo y el total actual de elementos,
no un popover. Su comando existente enfoca la sección. El rail entra
siempre al workspace/terminal real y los resultados de tareas de Command palette
abren el Plan Board de su owner exacto. Se conservan dispatch y controles de
Plan Board, Checks, Worldlines, Change Review, editor y recuperación de borradores;
no se añade una UI de tareas ni un ejecutor alternativo.

Los owners actuales son [renderer main](../../src/main.ts),
[búsqueda de trabajo](../../src/main/work-search.ts),
[rail](../../src/main/project-rail.ts),
[atención](../../src/main/attention-view.ts),
[herramientas contextuales](../../src/main/activity-pane.ts),
[Checks](../../src/main/checks-panel.ts) y
[detalle de checks](../../src/main/check-details.ts). La
[guía de usuario](../reference/USER-GUIDE.md) describe los recorridos vigentes.

Las secciones siguientes conservan el diseño, los hallazgos y la evidencia de
sus etapas anteriores; no se reescriben como si hubieran previsto esta retirada.
Los nombres de módulos/tests retirados y los comandos históricos no son rutas
actuales ni verificación de este cambio. El mock se conserva como estudio.

## 1. Decisión principal y regla confirmada

**La terminal debe ser el lugar donde se trabaja; Overview debe servir para supervisar, no convertirse en una capa que haya que atravesar para trabajar.**

El usuario probó manualmente la implementación y rechazó tanto «Project work» encima de la terminal como la cantidad de clics para llegar al trabajo de un proyecto. Indicó que la mayoría del trabajo ocurrirá en la terminal. Esto cambia la prioridad respecto de la [propuesta attention-first](attention-first-workspace.md): no basta con completar su mock ni cambiar etiquetas.

### Confirmado por el usuario

Al entrar explícitamente a un proyecto:

1. Si una terminal disponible necesita intervención humana para continuar, abrir esa terminal y enfocarla.
2. Si hay varias, priorizar la intervención que lleva más tiempo esperando; las otras permanecen señaladas. Desempate estable, no rotación por cada refresh.
3. Si ninguna necesita intervención, recuperar la última terminal utilizada y todavía disponible.
4. Si no hay terminales disponibles, mostrar acceso directo a crear un agente o abrir un shell; no crear una sesión por seleccionar el proyecto.

**Límites confirmados en la conversación:** no cambiar de terminal por una notificación mientras el usuario trabaja; un resultado pendiente de revisión, un check fallido o evidencia obsoleta no equivalen automáticamente a una terminal esperando input; pulsar una terminal concreta abre exactamente esa terminal. Un resultado de un worker cerrado debe tener acceso a revisión, no una terminal inventada ni el owner como sustituto del worker.

Esta regla define el destino, no autoriza ejecutar trabajo, responder permisos, verificar, reintentar, aceptar, aplicar archivos, stage o commit.

### Recomendaciones de presentación

- El rail siempre entra al proyecto con la regla anterior, incluso desde Overview. El filtrado se queda dentro de Overview.
- Eliminar la franja «Project work», no renombrarla ni esconderla detrás de una preferencia. Conservar sus hechos útiles y acceso a checks en herramientas contextuales.
- Unificar «Focus task / Focus context» y «Open terminal» en el workspace normal. Una sesión tiene un destino de trabajo, no dos presentaciones con reglas de retorno distintas.
- Mantener atención global accesible de forma compacta, sin desplazar foco por eventos de fondo.
- Mantener planes, resultados y comparaciones como herramientas contextuales. Conversar con un agente no exige crear una tarea de Plan Board.

**Confianza:** alta en la regla de entrada y el rechazo de la franja, por feedback explícito; alta en eliminar el significado dual del rail, por código observado; media en la composición final y retirada de Focus, que necesitan comparación visual y uso real.

## 2. Alcance, contexto y evidencia

| Contexto | Valor, fuente y confianza |
|---|---|
| Producto | Termina, desktop Electron con PTY real y Monaco. Observado en [package.json](../../package.json) y [AGENTS.md](../../AGENTS.md); alta. |
| Usuario principal | Desarrollador que trabaja principalmente en el TUI y consulta/edita archivos al lado. Proporcionado por el usuario y consistente con el manifiesto; alta para este usuario, adopción general desconocida. |
| Problema central | Dar instrucciones y seguir trabajo sin reconstruir contexto de proyecto/sesión. Inferido de código y feedback; media/alta. |
| Resultado deseado | Entrada directa a donde se puede continuar; revisión explícita cuando corresponde. Confirmado en conversación; alta. |
| Madurez inspeccionada | Rama local del follow-up de Overview; manifiesto versión `0.1.63`. Observado; no implica madurez comercial. |
| Superficies | Renderer desktop, TUI, archivos/editor, atención, planes, checks, resultados y comparaciones. |
| Métrica de éxito | Propuesta: tiempo hasta input aceptado por el TUI correcto, acciones y errores de contexto. Sin baseline medido. |
| Negocio, monetización y compra | No relevantes para este alcance; no investigados. |
| Evidencia | Implementación, contratos, documentación, tests escritos, mock anterior y feedback manual de un usuario. |
| Desconocido | Frecuencia por función, latencias reales, preferencias de otros usuarios, render por tamaño/tema, lector de pantalla y todas las colisiones de teclado. |

**Etiquetas:** proporcionado = comunicado por el usuario; observado = leído en implementación/test, no necesariamente ejecutado; inferido = interpretación razonada; propuesto = futuro no implementado; desconocido = evidencia insuficiente.

### Superficies revisadas

[Chrome principal](../../src/index.html), [orquestación renderer](../../src/main.ts), [rail](../../src/main/project-rail.ts), `src/main/project-overview.ts` (histórico; retirado), [atención](../../src/main/attention-view.ts), [checks, reemplazo actual del resumen](../../src/main/checks-panel.ts), `src/main/work-inspector.ts` (histórico; retirado), `src/main/new-task.ts` (histórico; retirado), [terminal menu](../../src/main/terminal-menu.ts), [layout](../../src/main/layout.ts), [estilos](../../src/styles.css), `src/main/project-overview.css` (histórico; retirado), [comandos](../../shared/commands.ts), [preferencias](../../shared/preferences.ts), [actividad canónica](../../electron/agent-activity.ts), [proyección canónica](../../electron/main/work-summary.ts) y [tipos](../../shared/types.ts).

Se contrastaron [tests de Checks, sucesores del resumen](../../tests/e2e/checks.spec.ts), `tests/e2e/overview-rail.spec.ts` (histórico; retirado), el [audit anterior](../reference/WORKSPACE-EXPERIENCE-AUDIT.md) y los límites del [mock](../mockups/workspace/README.md). Los tests se usaron como especificación, no como evidencia de ejecución de esta propuesta. Una revisión independiente read-only confirmó rutas, restauración y teclado.

| Recorrido/estado | Inspección realizada | No demostrado |
|---|---|---|
| Proyecto → terminal existente | Activación, restauración y foco en código | Latencia y entrada nativa |
| Overview → proyecto/terminal | Código y expectativas E2E | Comprensión por otros usuarios |
| Crear agente/shell | Menú y bridge del renderer | Admisión nativa multiplataforma |
| Tarea → worker/resultado | Identidad y controles del inspector | Recorrido nuevo de revisión completo |
| Teclado y retorno | Registro de comandos, ownership y Escape | Colisiones completas y lector de pantalla |
| Ventana compacta / zoom | Reglas CSS existentes | Render y accesibilidad del rediseño a 200 % |
| Fallo/cierre/reemplazo | Guardas de navegación y estados canónicos | Matriz completa de crash/lifecycle |

**Alcance:** auditoría profunda del núcleo de interacción, no auditoría exhaustiva de instalación, seguridad, proveedores, web pública, todas las preferencias o adopción. No se lanzó Electron ni se accedió a sesiones del host. No hay screenshots nuevos ni métricas. Las verificaciones históricas del plan anterior no validan este diseño.

**Estado verificado del worktree:** estaba limpio antes de esta auditoría y este documento no existía. En HEAD, `WorkOverview.projects` ya conserva `ProjectWorkSummary`, incluidas sus terminales, y `workOverview` proyecta el resumen completo. No hay un diff backend pendiente que integrar en este turno. Los resultados de tests históricos o ambiguos del handoff no se consideran checks de esta propuesta.

**Done de esta auditoría:** explicar fricción con código actual, distinguir lo confirmado de las hipótesis, proponer arquitectura y recorridos, señalar contratos faltantes y definir implementación/validación. Implementar UI es un trabajo posterior.

## 3. Núcleo de producto y mapa

En una frase: **Termina permite trabajar con un agente en una terminal real, con sus archivos al lado y herramientas para controlar trabajo paralelo y revisar resultados.**

```text
Entrar a proyecto → terminal que necesita intervención o última usada → escribir → ver archivos → revisar cuando corresponde
```

Supervisar aporta valor cuando hay varios trabajos o una decisión pendiente; no debe reorganizar la entrada a cada conversación.

### Inventario del alcance

Las frecuencias son feedback o hipótesis, no analítica. Costes describen complejidad observada, no horas estimadas. Cada fila agrupa una capacidad, no cada botón.

| Capacidad / evidencia | Clasificación | Problema, frecuencia y valor | Complejidad / solapamiento / fit | Recomendación | Confianza y qué se pierde al quitarla |
|---|---|---|---|---|---|
| Terminal real, `activatePane`/PTY | Core | Trabajar con agente; frecuente según usuario | Reemplazarlo duplica input/control. Es el núcleo. | KEEP | Alta. Se pierde control directo del agente y permisos. |
| Archivos/editor, `applyFolderOpened` | Core | Inspeccionar/editar código; valor alto inferido | Workspace debe coincidir con sesión real. | KEEP BUT SIMPLIFY | Alta. Se pierde el valor híbrido y consulta inmediata. |
| Proyectos/sesiones, rail/tabs | Core | Cambiar conservando trabajo | Dos niveles útiles; significado dual del rail añade aprendizaje. | KEEP BUT SIMPLIFY | Alta. Se pierde multiproyecto y selección exacta. |
| Franja Project work, `createWorkSummary` | Product debt de presentación | Resumir contexto; rechazo proporcionado | Otra vista de hechos de rail/inspector/checks. | REMOVE la presentación | Alta. Migrar datos útiles y acceso a evidence, no borrarlos. |
| Focus en Overview, `focusWork` | Product debt de presentación, inferido | Terminal junto a detalles | Préstamo del pane y otro retorno; compite con Open terminal. | MERGE con workspace | Media. Conservar contexto útil, no un segundo destino. |
| Atención global | Supporting | Encontrar intervención/resultados de fondo | Motivos útiles; varios son información, no input pendiente. | KEEP BUT SIMPLIFY | Alta. Se pierden decisiones de trabajo de fondo si desaparece. |
| Overview agrupado | Supporting | Supervisión de varios trabajos; uso desconocido | Tarjetas/filtros/inspector; no debe gatear terminal. | HIDE UNTIL NEEDED | Media. Sin él se pierde visión conjunta de trabajo paralelo. |
| Plan Board / tareas manuales | Supporting | Preparar/despachar trabajo estructurado | Owner exacto, creación y ejecución separadas. No es chat alternativo. | HIDE UNTIL NEEDED | Alta sobre ubicación. Se pierde planificación y dispatch si se elimina. |
| Candidatos/recuperación | Core para concurrencia | Evitar escritores sobre mismos archivos; retener intentos | Lifecycle real; no sustituible por flags de UI. | KEEP BUT SIMPLIFY exposición | Alta. Se pierde aislamiento, retención y recuperación. |
| Cambios/checks/decisión sobre resultado | Core para control | Saber qué cambió y decidir | Evidence y aceptación son distintas; Review/inspector/worldlines. | KEEP BUT SIMPLIFY | Alta. Se pierde confianza/control sobre archivos. |
| Timeline/replay/comparación | Supporting | Investigar/repetir/comparar; frecuencia desconocida | Valor técnico diferenciado, no requisito antes del prompt. | MOVE TO ADVANCED contextual | Media. No eliminar: se pierde investigación y comparación. |
| Búsqueda/comandos | Supporting | Llegar a contextos y acciones con teclado | Registro existente; algunos atajos poco visibles en rail. | KEEP BUT SIMPLIFY | Alta. Se empeora teclado y manejo de muchos contextos. |

No hay datos suficientes para eliminar planes, Overview, replay o comparación como capacidades. Su tamaño o coste pasado tampoco justifican exposición permanente.

## 4. Cinco fuentes prioritarias de fricción

Estos hallazgos son decisiones abiertas de diseño, no tickets de bugs cerrados.

| Hallazgo y evidencia | Coste / consecuencia inferida | Cambio, confianza y esfuerzo | Tradeoff / validación futura |
|---|---|---|---|
| Rail cambia de Open project a Filter Overview. `project-rail.ts:paint/onClick`, E2E del rail. | Usuario recuerda modo y busca segundo control; hay ruta alternativa directa por carril. | Rail siempre entra al proyecto; filtro local. Alta, bajo/medio. | Abandona paridad con mock; conservar drafts, exact roots y global attention. |
| Project work sigue visible aunque details esté colapsado. `index.html`, `createWorkSummary.render`. | Mezcla recuento de proyecto con terminal/tarea y añade lectura. Usuario lo rechaza. | Retirar franja y lifecycle; migrar `showCheck`. Alta, medio. | Pierde esa posición de resumen, no datos/checks/stale fences. |
| Focus y Open terminal llevan a composiciones distintas. `onFocusTerminal`, `focusWork`, `returnToOverview`. | Otra elección de destino y lifecycle de montaje. No es otro PTY. | Un destino de trabajo; herramientas al lado bajo demanda. Media, medio. | Probar que usuarios de Focus no pierden contexto ni evidencia cargada. |
| Inspector crea muchas acciones según estado. `createWorkInspector`. | Varios verbos de navegación compiten con Start, cierre y decisiones. No todos aparecen simultáneamente. | Principal contextual + secundarios inequívocos. Media, medio. | No ocultar recuperación/teclado ni convertir selección en ejecución. |
| New terminal abre siempre chooser agente/shell. `terminal-menu.ts`, comando `new-terminal`. | Elegir agente repetidamente, si su uso domina; proporción desconocida. | Probar New agent directo + menú shell. Media, medio. | Validar shell-first; preservar creación vacía, herencia y admisión real. |

Otros costes: hechos repetidos en rail/resumen/tarjeta/inspector/Focus y varias herramientas bajo el TUI antes de ser relevantes. Reducir texto repetido no permite reducir idle, blocked, resultado disponible y stale evidence a un engañoso «Done».

## 5. Recorridos actuales frente a propuestos

### Método

Conteos estáticos de acciones, no tiempos medidos. Un clic/chord que expresa intención cuenta como una acción; IPC, carga de módulo, hidratación y fit no son clics. Se supone proyecto abierto con terminal disponible, salvo indicación. No se contabiliza cada carácter, autenticación, permiso o selección nativa de carpeta como fricción eliminable.

| Objetivo | Actual | Propuesto | Cambio real |
|---|---|---|---|
| Volver a proyecto desde workspace | Rail → terminal recordada, **1 clic** | Rail → intervención pendiente o recordada, **1 clic** | Conservar ruta directa, mejorar destino. |
| Volver desde Overview | Open project del carril, **1 clic**; por rail: filtrar → Open project, **2 clics** | Rail → terminal correcta, **1 clic** | Quitar regla de modo; no afirmar dos clics en toda ruta actual. |
| Otra terminal del proyecto activo | Tab, **1 clic** | Tab exacto, **1 clic** | Selección explícita siempre gana; no redirigir al blocker. |
| Terminal específica por tarjetas | All projects → Details → Open terminal/Focus, **3 acciones** desde workspace | Proyecto → tab, hasta **2 acciones**; **1** si es el destino elegido | Inspección no es peaje para escribir. |
| Otro agente | New terminal → Agent, **2 acciones**, o chord → Enter | New agent/chord, **1 acción**, si se valida | Quita elección repetida, shell secundario. |
| Instrucción normal | Terminal → escribir → enviar; **sin Plan Board obligatorio** | Igual, con menos chrome | No inventar una limitación inexistente. |
| Intervención de fondo | Attention → inspección/navegación a contexto exacto | Entrar al proyecto → terminal que espera intervención | Elimina búsqueda de sesión; no responde por el usuario. |
| Preparar y empezar tarea | Composer → destino/outcome → Create → inspector → Start | Plan/contexto exacto → outcome → Create → Start explícito en el mismo contexto | Reducir selección redundante, no fusionar Create y Start. |
| Resultado con worker cerrado | Inspect details → controles de candidato; head se proyecta, diff del inspector exige terminal viva | Resultado → diff/checks capturados → decisión explícita | Acceso completo pendiente; no sustituir datos por owner/current disk. |

Si el proyecto está vacío, `activateProjectPane` pone `activeId = null`. No crea una terminal por navegar. Conservar creación como intención explícita.

## 6. Semántica de atención: contrato pendiente, no heurística de UI

**Hallazgo importante:** la regla aprobada no se puede implementar fielmente usando sólo los campos actuales del Overview.

Observado en [electron/agent-activity.ts](../../electron/agent-activity.ts): `activityFor` produce blocked por bucle de errores, stall, espera de escritura, pausa y salida a mitad de run. **Blocked no es sinónimo de permiso o respuesta humana pendiente.** No existe en esa vista una señal explícita de input/permiso pendiente. Además, [AgentActivityView](../../shared/types.ts) sólo publica `state` y `reason`; no la antigüedad de la intervención.

La actividad interna tiene `sinceSeq`/`updatedAt`, pero no basta copiarlos: secuencias locales no comparan terminales, y updatedAt de una señal reciente no es necesariamente el inicio de espera humana. La proyección [work-summary](../../electron/main/work-summary.ts) ordena categorías establemente; no acredita antigüedad de intervención.

### Contrato necesario para el diseño

- Distinguir intervención humana accionable de ejecución, espera interna, error histórico y review pendiente con una señal real del owner canónico. No inferirla de silencio, output PTY, regex de pantalla, count de attention ni un LLM.
- Mantener antigüedad de esa intervención en su fuente canónica si se aplica la prioridad confirmada. No inventar timestamps de primer render, arribo de IPC o refresh; no una segunda store de notificaciones en renderer.
- Seleccionar sólo una terminal realmente disponible y con identidad/generación/workspace validados. Un error de startup o `exited-mid-run` no autoriza enfocarla como si pudiera recibir input.
- Concentrar selección en una política de **entrada explícita al proyecto**, reutilizada por rail, shortcuts y búsqueda de proyecto. La validación privilegiada sigue en main; no duplicar reglas por botón.
- No insertar la prioridad en toda llamada genérica a `activateProjectPane`: `applyFolderOpened` también lo usa al sincronizar selección. De lo contrario una actualización podría deshacer un tab explícito o provocar saltos de foco.
- Una selección explícita de terminal, tarea o candidato mantiene su identidad y destino. La política genérica no la reemplaza.
- Si la intervención desaparece durante una entrada genérica, revalidar y recuperar una sesión válida según la regla. Si desaparece un target explícito, refusar sin sustitución silenciosa.

**No se afirma que hoy se detecten permisos/respuestas ni que ya se ordenen por antigüedad.** Es trabajo de producto/contrato necesario antes de declarar implementada la navegación inteligente. La copia «Espera tu respuesta» sólo puede mostrarse cuando ese hecho esté acreditado.

## 7. Decisiones humanas frente a defaults

| Decisión | ¿Necesita intención humana? | Simplificación | Límite |
|---|---|---|---|
| Ruta según modo Overview/workspace | No | Rail siempre navega | No cambiar sólo estado renderer. |
| Dónde continuar al entrar | Normalmente no | Intervención accionable más antigua; luego última válida | Señales canónicas, no cualquier warning. |
| Qué terminal concreta abrir | Sí | Tab/búsqueda exacta | No redirigir aunque exista otro blocker. |
| Crear sesión | Sí | Acción explícita, defaults existentes | No crear por navegar al vacío. |
| Modelo cada vez | Normalmente no | Herencia actual cuando procede, cambio en TUI | No otro catálogo/auth. |
| Elegir shell | Sí | Acción secundaria accesible; default agente por validar | No borrar capacidad ni introducir preferencia sin evidencia. |
| Proyecto/board para tarea | A veces | Destino exacto preseleccionado; owners ambiguos visibles | Draft no retargetea si cambia/desaparece owner. |
| Crear y ejecutar tarea | Sí, consecuencias distintas | Mismo contexto, dos acciones | No auto-Start, Retry o schedule al seleccionar/crear. |
| Leer cambios/checks | Sí | Lazy con raíz/fuente visibles | No Verify automático. |
| Aplicar/descartar resultado | Sí | Ninguna decisión inferida | No aceptación por visita, idle o check verde. |
| Interrumpir/cerrar | Sí | Target exacto y consecuencias existentes | Cerrar detalles no mata PTY; cerrar PTY no revierte archivos. |

## 8. Arquitectura de información

### Actual

```text
Rail
├── Proyecto → workspace; en Overview → filtro
├── All projects → Overview → Details → Focus dentro de Overview
│                                      └── Open terminal → workspace
└── Attention → inspección/navegación

Workspace
├── Terminal tabs
├── Project work
├── Terminal
├── Timeline / Plan / Worldlines / Modified
└── Explorer / editor / Review / statusbar
```

### Propuesta

```text
Proyecto → workspace único
├── Terminal accionable o última usada
├── Tabs → selección exacta
├── Archivos/editor → área real de esa sesión
└── Herramientas contextuales → Changes / Checks / Plan / History / Compare

Attention → decisión o terminal exacta
Overview → supervisión opcional, filtro local; no redefine navegación global
```

| Alternativa | Ventaja | Coste | Decisión |
|---|---|---|---|
| Mantener attention-first, acortar botones | Reutiliza mock | Conserva significado dual y dos destinos | No recomendar como dirección principal. |
| Rail estable + tabs + workspace existente | Reutiliza rutas directas | Dos niveles legítimos, proyecto y sesión | **Recomendada.** |
| Árbol de proyectos con todas sus terminales | Un clic a sesión visible de fondo | Expansión/scroll, densidad, duplicación si mantiene tabs | Comparar sólo si proyecto → tab sigue siendo insuficiente. No añadir ambos. |

### Boceto, no especificación de píxeles

```text
┌───────────────┬───────────────────────────────┬────────────────────────┐
│ Projects      │ Agent 1   Upload task    + ▾  │ Files / editor         │
│               ├───────────────────────────────┤                        │
│ termina       │ Terminal real                 │ greeting.ts            │
│ api           │                               │                        │
│ docs          │ prompt → ejecución → respuesta│ código / diff          │
│               │                               │                        │
│ Attention (2) │                               │                        │
│ Overview      ├───────────────────────────────┤                        │
│ Open folder   │ Changes · Checks · Plan · …  │                        │
├───────────────┴───────────────────────────────┴────────────────────────┤
│ Proyecto / área real                  estado factual / check actual │
└───────────────────────────────────────────────────────────────────────┘
```

Explorer puede conservar su ubicación inicialmente. La posición derecha del boceto es una alternativa visual, no requisito para arreglar navegación. No mezclar ese traslado con el primer contrato.

### Jerarquía y lenguaje

- Protagonista: TUI, no un título grande de tarea ni «One task. Full context.» antes de escribir.
- Tabs identifican sesión; título de tarea ayuda sólo cuando hay asignación real. Modelo, `term-N` y raíz accesibles sin inventar nombres mediante otro agente.
- Proyecto y suficiente path para distinguir homónimos; ruta completa accesible por teclado, no sólo tooltip.
- Project files frente a Separate candidate con texto y raíz real; simplificar no oculta dónde se escribe.
- Open terminal navega; New agent crea; Start task ejecuta; Inspect result lee. Apply to project y Discard result serían decisiones explícitas sobre candidato: etiquetas propuestas, no renombres aplicados.
- Working/Blocked, Result pending review y Pass/Failed/Outdated son dimensiones distintas. Idle no es Completed.
- Avisos y consecuencias siguen en acciones relevantes. Reducir boilerplate no elimina negaciones sobre aplicación automática, evidencia histórica o pérdida de archivos.

### Dirección visual

Conservar tokens y fuentes de [styles.css](../../src/styles.css): `--bg`, `--bg-panel`, `--border`, `--text`, `--text-dim`, `--accent`, `--yellow` y `--red`. Mantener Departure Mono y preferencias de fuente; texto largo puede conservar sans-serif usado por Overview. No nueva paleta, dependencia, tema o animaciones de dashboard.

La decisión distintiva es continuidad: misma sesión, mismo lugar, espacio útil y chrome silencioso. Tamaños finales se deciden con contenido real, ventana compacta y zoom; no con timestamps/logs ficticios.

## 9. Dominio y Dev UX

### Conceptos necesarios

Proyecto identifica el origen. Sesión/terminal identifica conversación y proceso. Workspace identifica los archivos reales seleccionados. Tarea identifica trabajo estructurado opcional. Candidato/resultado conserva un intento aislado y su captura. Evidencia identifica una ejecución y fuente, no aprobación.

No fusionar proyecto con workspace para reducir labels: haría indistinguible source de candidato. No usar owner como worker. No convertir cada atención en tarea, ni crear un estado «reviewed» sólo porque existía en el mock. No proponer rewrite de entidades por elegancia de código.

### Para quien desarrolla usando Termina

1. Entrada termina en TUI utilizable, no otro botón. Ready necesita selección autoritativa, no una clase CSS.
2. Cambiar y volver conserva sesiones y borradores. `lastActivePane` sólo acredita memoria renderer; no selección exacta durable tras reinicio.
3. Teclado primero: conservar cycling de proyectos/terminales y palette. Hacer visibles accesos existentes, no reasignar chords masivamente.
4. Conversación en TUI; New task prepara trabajo. No otro chat/composer que replique history, permisos o control.
5. Más clics no son aislamiento; menos clics no permiten escritores sobre el mismo árbol. Nuevas sesiones siguen admisión/sandbox/candidato canónicos.
6. Auth, presupuesto, startup y sandbox fallidos muestran motivo real y recuperación permitida. No shell/shared worker como fallback silencioso.

### Para quien mantiene el código

Reutilizar activación de proyecto, selección de terminal y `applyFolderOpened`. Una acción humana puede requerir varios IPC; quitarlos no es una métrica de UX.

| Corte | Owner/consumidores a migrar juntos |
|---|---|
| Entrada inteligente y rail estable | Política de entrada, hechos canónicos de intervención/antigüedad, `project-rail.ts`, wiring main/renderer, comandos/búsqueda, `attention-view.ts`, filtros y tests. No ejecutar política en cada hidratación. |
| Retirar franja | `index.html`, `styles.css`, creación/disposal renderer, `createWorkSummary`, carga/reportes, `navigateWorkAction` y `focusWorkContext` para evidence. |
| Conservar proyección y labels | Backend work-summary sirve rail/Overview. `ATTENTION_LABELS`/`ACTION_LABELS` tienen consumidores. No borrarlos ni duplicar regla por retirar el componente. |
| Un único destino | `focusWork`, `returnToOverview`, slot/CSS, callbacks de Focus, controles del inspector y tests del modo. Retirar préstamo de panes; migrar regresiones de identidad/contexto/buffers. |
| Agente directo, si validado | `terminal-menu.ts`, comando `new-terminal`, `createTerminal` existente, labels y tests. Sin segundo spawner ni store de defaults. |
| Resultados | Inspector y `worldlines.ts`; promoción/evidencia siguen `electron/worldlines/` y Rust. Sin merge paralelo en TS/renderer. |

`tests/e2e/overview-rail.spec.ts` (histórico; retirado) exige hoy filtrado sin navegación. Migrar el contrato, no debilitar assertions de borrador, sesiones, atención y homónimos; probar filtro local desde su nuevo control. La cobertura factual y stale de [checks.spec.ts](../../tests/e2e/checks.spec.ts) migra al acceso que reemplaza la franja.

Retirada completa de presentación: callbacks, estilos, handlers, tests exclusivos y docs del modo desaparecen juntos, sin aliases ni legacy toggle. No borra datos/IPC canónicos que siguen soportando capacidades conservadas. No hace falta un refactor de dominio para estas simplificaciones.

## 10. Configuración y automatización

| Configuración / lugar | Clasificación y recomendación | Evidencia pendiente |
|---|---|---|
| Tema, fuente, tamaños, wrap, shortcuts; `shared/preferences.ts` | Preferencias legítimas de usuario; mantener | No decidir eliminación por frecuencia no medida. |
| Minimap y auto-open de archivos; preferencias | Mantener por ahora; no cambiar defaults en este audit | Uso y si auto-open interfiere con escritura/revisión. |
| Geometría/orientación/minimización; `layout.ts` | Preferencia visual del owner existente; conservar | Uso por tamaños y retorno a buffers. |
| Modelo/effort; defaults existentes del agente | Default contextual, cambio explícito en TUI | No otro catálogo ni política de auth. |
| Terminal-first/attention-first, rail filtra/navega, mostrar Project work | No añadir | Son decisiones del producto, no trabajo permanente del usuario. |
| Señal de intervención / prioridad | Estado operativo canónico, no setting | Señales de permisos/input y antigüedad aún no expuestas. |

Navegación y restauración deben ser deterministas. No un supervisor LLM que deduzca urgencia, aceptación o el lugar donde trabajar. IA ya produce trabajo en el TUI; la aplicación hace su resultado inspeccionable.

Automatizar contexto/defaults válidos; no promoción, descarte, permisos, Retry, aceptación o primer prompt. Automatización útil no significa quitar control sobre consecuencias.

## 11. ¿Un producto o varios? Clean slate y 80/20

Trabajar y supervisar pueden convivir: no requieren productos separados. El error es darles protagonismo permanente igual. La prioridad terminal viene del usuario; no prueba que otros no necesiten supervisión.

Si empezara de cero construiría proyecto + sesión + archivos + resultados/decisiones, con búsqueda y herramientas contextuales. No construiría tablero obligatorio, dos homes de terminal, segundo chat, store de tareas paralela, scheduler nuevo, teams/billing o grid permanente de todas las terminales.

**Conteo del alcance:** 12 capacidades agrupadas en el inventario; 3 grupos merecen protagonismo cotidiano —proyecto/sesión, terminal y archivos—; 7 conservan acceso contextual/secundario; 2 presentaciones se retiran o consolidan —franja y Focus—. No son 12 features visibles simultáneamente ni una medición de adopción.

La jerarquía 80/20 es hipótesis. No se calcula un porcentaje de mejora/uso/espacio sin baseline; ocultar una capacidad no equivale a eliminarla ni quitar valor.

## 12. Si hubiera que recortar 30 % mañana

Recortaría presentación del camino principal, no aislamiento ni datos. No es 30 % medido del producto/código.

| Primer corte | Segmento que lo notaría / downside | Reemplazo y beneficio | Seguridad del corte |
|---|---|---|---|
| Project work + lifecycle montado | Usuarios del resumen; pierden esa posición | Checks/details contextuales; menos lectura y componente | Requiere migrar evidence, labels, callers, CSS, tests y docs. |
| Focus alternativo + préstamo de panes | Quien usa su composición; loaded context podría perderse | Workspace único con detalle solicitado; menos destinos | Validación previa y migración completa de callbacks/estado/tests. |
| Rail que filtra según modo | Supervisión acostumbrada al mock | Filtro local y navegación estable | Aprobable, pero migrate safety assertions/contrato. |
| Recuentos/negaciones/hechos repetidos | Quien escanea todos los facts | Un lugar por hecho, detalle accesible | Validar comprensión de fuente/evidencia; no borrar negaciones importantes. |
| Herramientas avanzadas prominentes antes de uso | Power users; menos descubribilidad | Acceso contextual/commands, no eliminación funcional | Medir descubrimiento/uso antes de retirar accesos. |

No recomendaría cortar replay, Plan Board, Overview o comparación completos sin datos. No se dejan shims, aliases o opciones old UI al retirar una presentación. No hay migración de datos propuesta para estos cortes; conservar historia/resultados y capacidades existentes.

## 13. Estados y límites que no se sacrifican

| Estado | Comportamiento propuesto |
|---|---|
| Sin proyecto | Carpeta + orientación breve, sin setup de workspace/tareas de ejemplo. |
| Proyecto con intervención accionable | Terminal disponible elegida por antigüedad acreditada, señal pequeña y factual. |
| Proyecto sin intervención | Última válida; si no sobrevive, fallback de navegación genérica a superviviente disponible. |
| Proyecto vacío | Crear agente/shell explícitamente. |
| Activación pendiente | Señal acotada; target y generación revalidados; intento nuevo invalida el anterior. |
| Tab/resultado explícito cerrado o reciclado | Refusar sin sustituir por owner/homónimo/otra sesión. |
| Nueva atención mientras escribe | Señalar sin cambiar proyecto, terminal, root, foco o input. |
| Error/espera interna | Frase factual; no decir «Espera tu respuesta» sin esa señal. |
| Shell ejecutando | No inferir tarea completa o activity del agente. |
| Worker cerrado con resultado retenido | Review sigue pendiente; objetivo es captura exacta, no owner/current disk. Acceso completo aún pendiente. |
| Check stale/fallido/cancelado | Fuente e histórico distintos; inspección no rerun ni aceptación. |
| Candidato en conflicto/error | Recuperación real admitida, no abrir/promover sólo porque existe directorio. |
| Dirty buffers | Navegación no guarda/descarta implícitamente; owner por proyecto/workspace. |
| Compacto/zoom | Terminal usable, controles de decisión encontrables por teclado, raíz accesible. Render sin verificar. |

Preservar write leases, sandbox, policy de plataforma, main responsivo, captura/merge Rust, generaciones/roots, lifecycle PTY y retención. Cerrar detalles no para procesos; cerrar PTY no revierte; inspeccionar no acepta, stage, commit ni aplica archivos.

## 14. Roadmap, migración y decisiones pendientes

| Orden | Cambio / beneficio | Esfuerzo / confianza | Riesgo y próximo paso |
|---|---|---|---|
| 0 | Prototipo terminal-first con mismos estados; validar composición | Pequeño / media | Sin éxito de lifecycle ficticio; contrastar una/múltiples sesiones y teclado. |
| 1 | Señales canónicas de intervención/antigüedad + entrada explícita estable | Medio / alta en regla, contrato pendiente | Reusar owners; no tratar blocked o count como input humano. |
| 2 | Rail siempre navega; filtro local | Bajo/medio / alta | Migrar ruta y safety assertions, mantener entrada exacta. |
| 3 | Retirar Project work, migrar acceso a checks | Medio / alta | No perder destination de evidence ni stale fences. |
| 4 | Unificar Open terminal/Focus | Medio / media | Conservar pane, buffers, contexto y acceso a evidencia. |
| 5 | Agente directo si validado; reducir acciones/herramientas permanentes | Medio / media | Shell, recuperación, permisos y budget reales. |
| 6 | Review accionable de resultado retenido | Medio/alto / alta en necesidad | Captura/checks exactos; promoción/conflicto/descarte y attention sólo resuelta al decidir. |
| 7 | Usabilidad y rendimiento del conjunto | Según protocolo | No declarar productividad mejorada por tests funcionales. |

### Migración

- **Simplificación con evidencia suficiente:** franja rechazada y significado dual del rail. Seguir siendo reversible en código no evita migrar sus consumidores.
- **Necesita datos/comparación:** prominencia de Overview, retirada completa de Focus, default agente/shell y sesiones en rail.
- **Necesita contrato:** intervención y antigüedad no disponibles en la vista actual. Completar el productor canónico, no compensar en renderer.
- **Necesita coordinación:** destinos evidence/Focus, comandos, callbacks, estilos, tests y docs. Actualizar interfaces/callers juntos, sin aliases ni legacy toggle.
- **Datos y externos:** no esquema, billing, integración, URLs públicas o permisos nuevos propuestos para presentación. No borrar sesión/historia/candidato. Persistir terminal exacta seleccionada tras reinicio sería trabajo adicional de lifecycle, no una garantía del mapa renderer.
- **Rollback:** revertir un slice cohesivo antes de lanzamiento preserva datos; no mantener dos UIs o políticas en runtime. No hacer stage/commit de cambios ajenos.

No se repite Phase 4 del plan anterior. Concurrencia/recuperación/evidencia siguen siendo contratos activos. Review de resultados retenidos sigue pendiente: cambia composición/prioridad, no desaparece. La usabilidad pendiente de Phase 5 debe evaluar esta dirección, no paridad con el mock como éxito.

## 15. Validación y umbrales para cambiar de opinión

### Ejercicio manual

Comparar versión actual y prototipo con mismo contenido, distintas entradas y datos sintéticos:

1. Entrar desde workspace y Overview a proyecto sin intervención; escribir en última sesión.
2. Entrar a proyecto con una intervención, luego varias; elegir la más antigua, sin confundir check o resultado.
3. Durante escritura, generar nueva atención y demostrar que no cambia foco; abrir un tab explícito aunque otro requiera atención.
4. Cambiar/volver con un borrador sin guardar, incluyendo homónimos y workspace de candidato.
5. Crear agente y abrir shell sin Plan Board; preparar tarea sin correrla, Start explícito aparte.
6. Inspeccionar resultado con worker cerrado, distinguir check actual/histórico y tomar decisión.
7. Repetir entradas con teclado y zoom nativo 200 %; Escape y controles propios del TUI siguen perteneciendo al TUI.

Registrar acciones/decisiones, tiempo hasta input **aceptado por el TUI correcto**, errores de proyecto/workspace, retorno, pérdida de contexto y controles no encontrados. Sin telemetría externa de prompts/código/credenciales; grabaciones sólo con consentimiento/datos sintéticos.

### Objetivos, no métricas conseguidas

- Una acción desde rail en todas las vistas, cuando existe una terminal disponible.
- Una acción para tab exacto, sin PTY nuevo ni prioridad de blocker que lo sustituya.
- Cero saltos de foco por background refresh y cero saves/discards implícitos.
- Cero selección de owner como worker o de homónimo como proyecto exacto.
- Intervención, ejecución, review y evidencia se distinguen; attention no desaparece por visitar.
- No empeorar descubrimiento de decisiones de fondo.

No fijar porcentaje de tiempo ni p95 inventado. Obtener baseline antes de afirmar mejora. Conteos son contrato de interacción; latencia es una medida separada.

| Decisión / confianza | Evidencia necesaria | Umbral de reconsideración |
|---|---|---|
| Prioridad de entrada / alta, confirmada | Intervenciones reales, múltiples targets y navegación exacta | Si no hay señal/antigüedad autoritativa, no declarar implementada la regla con aproximaciones. |
| Retirar Focus / media | Mismas tareas/composición/contexto cargado | Si se pierde fuente/evidencia o loaded context, resolver composición antes del corte. |
| Overview secundario / media | Encontrar decisiones entre varios proyectos | Si no se descubre una decisión de fondo, mejorar señal/acceso; no reinstalar gate al terminal. |
| Default agente / media | Agente-first y shell-first | Si shell no se encuentra/completa por teclado o se crean agentes por error, mantener menú hasta resolverlo. |
| Tabs frente a sesiones en rail / media | Selección exacta multiproyecto | Si proyecto → tab provoca búsquedas/errores habituales, comparar árbol sin duplicar tabs. |
| Menos texto / media | Explicar fuente, captura, ejecución y stale evidence | Si se confunden dimensiones, restaurar hecho necesario en su lugar, no boilerplate en todas las capas. |

### Checks técnicos de futura implementación

Scripts canónicos en [package.json](../../package.json):

```sh
pnpm run typecheck
pnpm run typecheck:tests
pnpm run test:unit tests/unit/ui/project-rail.test.ts tests/unit/ui/attention-view.test.ts tests/unit/ui/project-overview.test.ts tests/unit/ui/work-inspector.test.ts tests/unit/ui/checks-panel.test.ts tests/unit/ui/work-search-navigation.test.ts
pnpm run build
pnpm run test:e2e tests/e2e/overview-rail.spec.ts tests/e2e/overview-context.spec.ts tests/e2e/project-overview.spec.ts tests/e2e/checks.spec.ts tests/e2e/work-search.spec.ts tests/e2e/multiproj.spec.ts --workers=1 --retries=0
```

Son archivos actuales; migrar lista cuando se retiren componentes conservando behavior tests. Añadir suites del productor de intervención/orden, creación y review según slice. Evitar standalone `--` antes de paths: en runs históricos amplió selección inesperadamente. Build antes de Electron; fixtures aisladas, process identity y cleanup canónicos; no host sessions ni safeguards desactivados.

Esta auditoría no ejecutó esos comandos. Verificación documental: enlaces/paths, scripts citados, whitespace y alcance. Typechecks, build, E2E, render, lector de pantalla y métricas del rediseño quedan sin ejecutar porque no hay código de producto cambiado.

## 16. Recomendación final

**Qué debe ser:** herramienta para continuar trabajo en el TUI correcto con archivos al lado y decisiones explícitas cuando hacen falta.

**Qué se ha acumulado:** una ruta directa que ya funciona, rodeada de navegación dependiente del modo, dos presentaciones de terminal y resúmenes superpuestos. No es fallo de concurrencia ni prueba de que toda supervisión sobre.

**Retirar primero:** franja y significado dual. **Consolidar:** Focus/Open terminal y hechos repetidos. **Automatizar:** destino de entrada con señales reales, no ejecución ni aceptación. **Ocultar hasta relevancia:** planes/history/compare/supervisión. **Preservar:** PTY, archivos, aislamiento, retención, evidencia, review y acceso multiproyecto; sin ellos se pierde trabajo, control o seguridad.

```text
Antes: elegir modo/ruta → buscar contexto → elegir cómo abrir la misma terminal.
Después: proyecto → intervención accionable o última terminal → continuar.
```

El siguiente paso recomendado por la auditoría era validar composición y completar el contrato de intervención para implementar esta regla sin heurísticas. La sección siguiente registra el avance posterior de ese contrato. No añadir más botones al mock attention-first ni rehacer concurrencia. Los otros cortes siguen siendo recomendaciones hasta su validación/aprobación.

## 17. Implementación posterior: contrato canónico de permisos pendientes

Implementación local en este worktree, posterior a la base de la auditoría:

- [El lifecycle del picker](../../agent-core/main/approval.ts) emite una petición explícita sólo cuando el usuario puede responder. Conserva identidad y fecha de inicio; los prompts encolados no adelantan esa fecha y los canales headless no son intervención humana.
- [El contrato compartido](../../shared/types.ts) añade `AgentActivityView.intervention`: `{ requestId, kind: "permission", since }` o `null`. `since` procede del productor y no se recalcula por polling, recepción de eventos o render.
- [El reductor de actividad](../../electron/agent-activity.ts) distingue permiso pendiente de bloqueos internos y conserva la petición durante actividad ajena o settlement del padre. Una resolución antigua no limpia una petición nueva; la salida de la terminal sí la limpia.
- [La proyección canónica](../../electron/main/work-summary.ts) conserva la información y ordena las intervenciones reales por antigüedad, con desempate estable. Una petición sustituida invalida el destino de atención anterior. Ninguna lectura consume el permiso.
- Renderer detecta cambios de petición aunque `state` y `reason` sean iguales. Refrescar hechos no abre vistas, cambia de terminal ni responde permisos.
- Los productores actuales son permisos de bash, archivos protegidos y permisos de subagentes mostrados en el padre. Checks fallidos, resultados para revisar, bloqueos internos y preguntas sólo en texto libre no se convierten en intervención.

**Fuera del slice de contrato de esta sección:** selección automática al entrar a un proyecto, restauración de última terminal y semántica del rail; su integración posterior se registra en la sección 18. La eliminación de «Project work», convergencia Focus/Open terminal y rediseño visual de Overview siguen fuera de alcance. Este contrato por sí solo aporta los datos necesarios, no acredita esos recorridos.

**Verificación:** typechecks, pruebas unitarias focalizadas y build ejecutados. La suite `tests/e2e/agent-activity.spec.ts` se intentó, pero falló durante el setup del fixture: este entorno niega `/bin/ps` (`EPERM`) y no permite identificar de forma segura los procesos de Electron. No se ejecutaron sus aserciones; no se debilitó la protección de aislamiento/limpieza. Para completar esa verificación se necesita ejecutar `pnpm run test:e2e tests/e2e/agent-activity.spec.ts` en un entorno que permita el censo de los procesos propiedad del fixture.

El [contrato de arquitectura](../reference/AGENT-CORE.md#canonical-human-intervention) detalla productores, señales y límites.

## 18. Integración posterior: entrada terminal-first al proyecto

- [Main](../../electron/main.ts) distingue `projectActivate(projectId, "entry")` de la activación de contexto (`"context"`). El IPC valida ambas intenciones; `folder:opened` y la respuesta incluyen la identidad exacta de terminal (`id` y `generation`) o `null`.
- La [política de entrada](../../electron/main/project-entry.ts) prioriza intervenciones reales por `since`, con desempate estable. Main sólo ofrece terminales vivas del proyecto con workspace disponible. Sin intervención, usa la última terminal admitida y su generación; si ya no está disponible, la primera disponible. Sin terminales, conserva el contexto primario sin crear una sesión.
- La memoria de última terminal vive en main durante la vida del proyecto abierto. Sólo se actualiza al admitir una selección; no por actividad de fondo. No se añadió persistencia de la selección tras reiniciar la aplicación.
- La elección ocurre después del I/O de autenticación y respeta las guardas existentes de proyecto, workspace, renderer y selección. Una selección explícita no reutiliza una activación automática pendiente ni una activación de otra terminal del mismo workspace.
- [Renderer](../../src/main.ts) pinta el destino admitido sin volver a seleccionar por su cuenta; espera su generación exacta si el roster llega después. El [rail](../../src/main/project-rail.ts), Enter y los atajos de proyecto entran al workspace y cierran Overview. Overview conserva su búsqueda textual, inspección global y borradores; una navegación desde su inspector conserva su token hasta que su propio lifecycle cierra la vista.
- El [estado vacío](../../src/main/terminal-empty.ts) ofrece «Create agent» y «Open shell» mediante el API existente de creación. Mostrarlo no crea terminales ni cambia foco. Las acciones coalescen durante una petición, anuncian errores y permiten retry; una respuesta tardía no activa su terminal si el usuario cambió de proyecto o hizo otra entrada.
- Se retiraron callbacks, estado, controles y estilos del filtro exacto por proyecto del rail. No se retiró la búsqueda textual de Overview ni la franja «Project work».

Las pruebas de [main](../../tests/unit/electron/workspace-selection-main.test.ts) cubren prioridad, generaciones, disponibilidad, selección explícita y carreras de admisión. Las pruebas de [renderer](../../tests/unit/ui/project-terminal.test.ts) cubren identidad exacta, orden folder/roster, intenciones de navegación y acciones vacías. [El caso E2E](../../tests/e2e/agent-activity.spec.ts) añade intervención múltiple, estabilidad de foco, selección explícita y retorno a la terminal recordada. Al terminar la integración inicial sólo estaba escrito, tipado y listado; su ejecución posterior consta en la sección 19.

**Límite de la integración inicial:** no se lanzó Electron, según la restricción entonces vigente del usuario. La limitación histórica de `/bin/ps` (`EPERM`) corresponde al intento anterior. No se acreditaron render visual, usabilidad ni latencias medidas en esa etapa.

## 19. Verificación posterior con Electron autorizado

El usuario autorizó continuar con la verificación E2E. En esta ejecución `/bin/ps` permitió leer la identidad de nacimiento y el censo de procesos. Se usó el launcher y la limpieza del [fixture canónico](../../tests/e2e/fixtures.ts), con proyecto, eventos, áreas de trabajo, user data y HOME aislados. No se usó el árbol de sesiones del host.

Se corrigieron las expectativas y la preparación de las pruebas, sin modificar producción:

- La segunda sesión independiente escribe sus eventos en su directorio aislado, no en el directorio global. La prueba de intervención múltiple conserva la validación de productor y secuencia.
- Los indicadores del rail se prueban con sus contadores actuales de trabajo y atención, no con el indicador antiguo de estado. La actividad de fondo no cambia el proyecto seleccionado.
- El cierre de una shell viva se confirma mediante el [helper existente de diálogos](../../tests/e2e/lifecycle-dialog.ts). La prueba verifica también que main pidió confirmar esa terminal exacta.
- En los casos anidados de [navegación de archivos](../../tests/e2e/project-file-navigation.spec.ts), el agente pertenece a un área aislada porque su árbol primario se solapa con el del primer proyecto. Abrir el archivo original muestra el workspace primario vacío, no una terminal de otra área. Cuando la terminal sí pertenece al workspace del archivo, las aserciones comprueban su `id` y `generation` exactos. Los gestos reales de texto envuelto y OSC 8 conservan sus comprobaciones de proyecto, archivo, posición del editor y búsqueda.

Verificación observada:

- `pnpm run typecheck` y `pnpm run typecheck:tests`: pasaron.
- Unit tests del alcance (UI, selección main, intervención, actividad y resúmenes): 1.004 pruebas en 74 archivos, todas aprobadas. La regresión focalizada del harness de navegación también pasó después de sus últimos cambios E2E.
- `pnpm run build`: pasó antes de lanzar Electron; no hubo cambios posteriores en producción. Vite emitió su aviso de tamaño de chunks.
- Ejecución final, sin reintentos: 20 E2E aprobados en las cuatro suites relacionadas. Los fallos iniciales se reprodujeron, se corrigieron y se verificaron primero por su causa y después en conjunto.

```bash
pnpm run test:e2e tests/e2e/overview-rail.spec.ts tests/e2e/project-overview.spec.ts tests/e2e/agent-activity.spec.ts tests/e2e/project-file-navigation.spec.ts --retries=0
```

Durante el cierre hubo avisos de GPU y de timeout del drenaje PTY; no fallaron las aserciones ni se informó limpieza no confirmada. Esta evidencia cubre los recorridos automatizados anteriores, incluido el layout compacto al 200 %; no sustituye una revisión visual manual, un estudio de usabilidad, pruebas con lector de pantalla ni mediciones de latencia. En esa verificación, retirar «Project work» y el resto del rediseño de presentación todavía estaban fuera de alcance. La autorización y los cambios posteriores se registran en la sección 20. No se hizo staging ni commit.


## 20. Simplificación posterior autorizada: un destino de terminal y herramientas bajo demanda

El usuario autorizó continuar los tres cortes de presentación. Implementación local:

- Se retiraron la franja **Project work**, su DOM/CSS y su componente. La proyección de hechos de main sigue siendo canónica: rail, Overview e inspector conservan tareas, ejecución, candidatos, resultados pendientes y acciones explícitas. [Checks](../../src/main/checks-panel.ts) ofrece el informe de la terminal seleccionada bajo demanda. Los [labels compartidos del renderer](../../src/main/work-labels.ts) y el [lector lazy de informes](../../src/main/check-details.ts) sustituyen las responsabilidades reutilizadas del componente retirado.
- Se retiró el modo Focus de Overview, su slot y el préstamo de panes. **Open terminal** abre la sesión canónica en el workspace. Suspender el inspector cancela Start pendiente sin borrar selección, diff ni informe mientras su identidad siga siendo válida. Terminal, workspace, generación y evidencia exacta invalidan el contexto cuando cambian. Un worker cerrado no se sustituye por la terminal del owner; su plan y resultado conservan sus accesos propios.
- La [barra de herramientas](../../src/activity-tabs.ts) conserva Checks, Timeline, Plan, Worldlines y Modified. Arranca cerrada, incluso con un tab guardado. Sólo una selección explícita abre un panel; llegadas de contenido actualizan badges sin abrir ni cambiar herramientas. Close y Escape desde una herramienta conservan su contenido y devuelven foco al tab. Escape del TUI no se intercepta. No se añadió preferencia ni camino alternativo.
- Se migraron las pruebas de resumen/Focus a sus destinos reales. La E2E del worker comprueba el mismo pane, objeto xterm, `id`/`generation`, texto introducido e informe cargado al navegar y volver a Overview. [La E2E de herramientas](../../tests/e2e/terminal-tools.spec.ts) cubre apertura, cierre, Escape, recuperación de altura, contenido retenido, badges restaurados y arranque cerrado al recargar, con zoom nativo de 100 % y 200 %.

Verificación final de esta etapa:

- Ambos typechecks y los **778 tests de UI en 69 archivos** pasaron después de los cambios finales. Build pasó antes de las E2E; conserva el aviso de tamaño de chunks.
- **93 E2E pasaron sin reintentos**, en dos ejecuciones serializadas de 43 y 50 casos: Attention, Overview, búsqueda, Start/Retry, workers, candidatos, resultados pendientes, Checks, herramientas, geometría, historia incompleta, Verify y accesibilidad por tema/fuente. No es una afirmación de que toda la matriz Electron esté verde.
- Se migraron expectativas antiguas de etiquetas y retorno. El caso de resultado retenido espera el estado real `settled` en el renderer antes de abrir controles, en lugar de actuar sobre su snapshot anterior `ready`. No se cambiaron los guards ni se añadieron sleeps/reintentos.
- La regresión adicional de Plan Board expuso **cinco fallos de admisión preexistentes**. Se reprodujeron los mismos cinco fallos con una copia temporal de `git archive HEAD`, commit `6e839c36`, build y fixtures aisladas. No se modificaron esas aserciones ni se relajó el aislamiento. Se excluyeron explícitamente sólo esos cinco casos de la segunda ejecución final; la suite completa de Plan Board falló por ellos en esa etapa. Su diagnóstico es independiente de este corte de presentación; la migración posterior se registra en la sección 21.
- `git diff --check` pasó. Se revisó el diff y se retiraron la copia de baseline y los logs temporales. No hubo cambios en Rust; no se ejecutaron sus unit tests ni la matriz completa/packaged de Electron.

Comandos finales de Electron:

```bash
pnpm run test:e2e \
  tests/e2e/attention-view.spec.ts \
  tests/e2e/project-overview.spec.ts \
  tests/e2e/work-search.spec.ts \
  tests/e2e/pending-review.spec.ts \
  tests/e2e/work-inspector-candidate.spec.ts \
  tests/e2e/start-task.spec.ts \
  tests/e2e/work-inspector-worker.spec.ts \
  --retries=0

pnpm run test:e2e \
  tests/e2e/terminal-tools.spec.ts \
  tests/e2e/checks.spec.ts \
  tests/e2e/resize.spec.ts \
  tests/e2e/plan-board.spec.ts \
  tests/e2e/verify-execution.spec.ts \
  tests/e2e/verify-observation.spec.ts \
  tests/e2e/incomplete-history.spec.ts \
  tests/e2e/workspace-accessibility.spec.ts \
  --grep-invert 'blocks an independent|agent and shell admission|physical-source alias|source denial|allows nested navigation' \
  --retries=0
```

Reproducción del baseline, dentro de su copia temporal:

```bash
pnpm run build
pnpm run test:e2e tests/e2e/plan-board.spec.ts \
  --grep 'blocks an independent|agent and shell admission|physical-source alias|source denial|allows nested navigation' \
  --retries=0
```

Las fixtures aún emiten avisos de GPU, drenaje PTY y captura/snapshot cuando se ejercitan rutas de fallo. Los casos seleccionados finales pasaron y no se informó limpieza no confirmada.

No es una afirmación de mejora medida, prueba de usabilidad o validación con lector de pantalla. Se conservaron los tokens, el aislamiento y los owners de PTY, sesiones, snapshots y evidencia. No se hizo staging ni commit.

## 21. Migración posterior: los cinco casos de admisión de Plan Board

Tras el diagnóstico y la corrección de la copia privada de MCP/auth, se migraron los cinco casos de [Plan Board](../../tests/e2e/plan-board.spec.ts) al contrato actual. Cuatro fallos correspondían a expectativas antiguas de rechazo, directorio de trabajo o ubicación de eventos; el caso MCP también encontraba un defecto real de copia antes de alcanzar la admisión. La evidencia histórica de la sección 20 se conserva como resultado de aquella ejecución, no como estado actual de la suite.

La migración conserva y comprueba las protecciones:

- El segundo agente se crea como worldline con `role: "session"`; su cwd y sus eventos pertenecen al área aislada. Una llamada real a `write_file` modifica únicamente el árbol del candidato mientras el owner sigue planificando; el source original permanece intacto.
- `/plan` solicita admisión observacional (`readOnly: true`) y puede coexistir con un shell. Un prompt normal continúa rechazado mientras el shell vive. Tras el cierre nativo del shell, ese prompt puede continuar; un nuevo shell se rechaza mientras el agente conserva la admisión de escritura (`readOnly: false`).
- Abrir un alias físico conserva un único proyecto visible, con la misma identidad y raíz. Su segundo agente escribe en un árbol aislado, no en el alias ni en el source.
- MCP usa una configuración privada real copiada al candidato y un script relativo al cwd de cada agente. Una denegación por shell activo no inicia MCP ni llama al proveedor. El agente aislado sí inicia el mismo servidor, cuyo marcador queda sólo en su árbol.
- El proyecto anidado conserva su identidad visible; su agente se identifica por proyecto, no por `cwd === nested`. La escritura se realiza en el área aislada, sin modificar el árbol anidado ni el source padre.

No se fabricaron eventos ni se sustituyeron los efectos de las herramientas por mocks. El proveedor loopback pide las escrituras a los agentes reales; sus respuestas declaran el trabajo incompleto cuando no se ejecutó una verificación. No se cambiaron los guards de admisión, las write leases, el sandbox ni el código de UI en esta etapa.

Verificación observada después de los cambios:

- Ambos typechecks y **103 pruebas unitarias focalizadas** de Plan Board, creación de sesiones y admisión pasaron.
- Build pasó antes de Electron, con el aviso de tamaño de chunks.
- Los **cinco casos migrados** pasaron sin reintentos en una ejecución focalizada.
- La suite completa de Plan Board pasó: **14 E2E**, sin exclusiones ni reintentos.

```bash
pnpm run typecheck
pnpm run typecheck:tests
pnpm run test:unit tests/unit/electron/plan-create.test.ts tests/unit/electron/plan-start.test.ts tests/unit/electron/independent-session.test.ts tests/unit/electron/user-terminal-creation.test.ts
pnpm run test:unit tests/unit/electron/source-admission.test.ts tests/unit/electron/source-admission-main.test.ts
pnpm run build
pnpm run test:e2e tests/e2e/plan-board.spec.ts --grep 'admits an independent writer|read-only planning admits|physical-source alias|source denial precedes|allows nested navigation' --retries=0
pnpm run test:e2e tests/e2e/plan-board.spec.ts --retries=0
```

Las fixtures siguen emitiendo avisos de drenaje PTY y GPU; en la suite completa también se observó `could not write mailbox context: snapshot core is disposed` durante teardown. Las ejecuciones anteriores terminaron con exit 0. Esto no acredita toda la matriz Electron. Los checks globales Rust y de formato no se repitieron en esta etapa: no hubo cambios nuevos en el core. No se hizo staging ni commit.

El usuario eligió después la creación directa de agente con shell accesible desde menú; su implementación y verificación se registran en la sección 22. La revisión accionable de resultados retenidos no forma parte de ese encargo. La presentación terminal-first de la sección 20 ya está implementada.

## 22. Creación de agente en una acción, shell desde menú

Implementación autorizada en este worktree:

- `＋` se identifica como **New agent** y crea directamente. El comando existente `new-terminal`, su atajo `Cmd/Ctrl+T`, el menú nativo y la búsqueda de comandos usan la misma acción. Se conserva el identificador del comando y su configuración de shortcuts; no hay alias ni chooser alternativo para agente.
- El botón secundario `▾`, **Open shell menu**, ofrece únicamente los shells detectados. Usa botones con roles de menú, foco real, Arrow keys, Home/End y Enter; Escape cancela y devuelve foco al opener. Cerrar por clic externo no roba foco al editor. Una lista pendiente no reaparece después de cancelar, crear o disponer la vista.
- [El control de creación](../../src/main/terminal-menu.ts) coalesce peticiones mientras una creación está pendiente, deshabilita ambos botones y muestra errores reales mediante el aviso existente. Permite retry explícito. Se retiró la terminal ficticia de error y su excepción al roster; un rechazo no crea una sesión ni cambia de política.
- [Renderer main](../../src/main.ts) reutiliza un único helper para las acciones del strip y del estado vacío. Captura proyecto y generación, pasa la referencia del pane activo válido sólo para crear agentes y selecciona el resultado cuando el contexto sigue vigente. Main conserva su política existente de modelo/effort. No activa respuestas tardías de otro proyecto. Main continúa decidiendo admisión, source frente a sesión independiente, presupuesto y sandbox; no se cambió ese contrato.
- Crear no envía un prompt, inicia una tarea ni aplica archivos. El shell se abre deliberadamente en el source del proyecto, no en el candidato seleccionado. La [guía de usuario](../reference/USER-GUIDE.md#terminals) y las etiquetas de comandos se actualizaron juntas.

Verificación final observada:

- `pnpm run typecheck` y `pnpm run typecheck:tests`: pasaron.
- **802 pruebas unitarias en 73 archivos**: toda la UI más las suites de flujo IPC y creación de terminales indicadas abajo. Una expectativa estructural de la antigua terminal ficticia se migró al nuevo roster sin debilitar la protección de terminales cerradas.
- `pnpm run build`: pasó después de los últimos cambios de producción; Vite conserva su aviso de tamaño de chunks.
- **22 E2E sin reintentos**: tres casos de creación directa, dos de reorder, tres de herramientas y los catorce de Plan Board, sin exclusiones. Cubren clic, atajo desde Overview, menú nativo, readiness del candidato, ausencia de prompt automático, shell real por teclado, Escape y límites de layout al 100 % y al 200 % de zoom. El límite real de tres áreas rechaza otra creación sin fallback ni terminal ficticia.
- Las primeras ejecuciones del nuevo spec expusieron preparación aún en estado `creating` y el alias macOS `/var` frente a `/private/var`; las pruebas esperan ahora readiness real y comparan identidad física. También detectaron la etiqueta antigua del menú nativo, que se corrigió en su productor. No se añadieron sleeps ni reintentos automáticos.
- `git diff --check`: pasó. Sin staging ni commits.

```bash
pnpm run typecheck
pnpm run typecheck:tests
pnpm run test:unit tests/unit/ui/ tests/unit/electron/ipc-project-flow.test.ts tests/unit/electron/user-terminal-creation.test.ts tests/unit/electron/terminal-creation-owner.test.ts
pnpm run build
pnpm run test:e2e tests/e2e/new-agent.spec.ts tests/e2e/tab-reorder.spec.ts tests/e2e/terminal-tools.spec.ts tests/e2e/plan-board.spec.ts --workers=1 --retries=0
```

Las fixtures emitieron avisos de GPU y timeout del drenaje PTY durante teardown, pero la ejecución final terminó con exit 0 y no informó limpieza no confirmada. No se ejecutó toda la matriz Electron ni el paquete distribuido. No hubo nuevos cambios Rust; no se repitieron sus tests ni sus checks globales de formato. Esta evidencia funcional no constituye una medición de productividad ni un estudio de usabilidad.
