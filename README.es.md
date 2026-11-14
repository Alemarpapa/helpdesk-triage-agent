# 🎫 Helpdesk Triage Agent — primero propone, una persona aprueba antes de cualquier cambio

*Versión en español de [README.md](README.md), para revisión del autor. El texto oficial es el inglés.*

Una herramienta chica de triage para un equipo de soporte. Lee tickets, aplica reglas configurables y **propone** quién debería tomar cada uno. Nada se asigna hasta que una persona aprueba la propuesta desde la línea de comandos. Cada propuesta y cada decisión queda en un registro de auditoría de solo agregado en SQLite.

También arma un reporte diario en Markdown y un resumen de correo que lista solo el correo no leído de las últimas 48 horas que te pide hacer algo. Marcar ese correo como leído también es una propuesta que necesita aprobación.

> **Alcance, con honestidad:** es un proyecto de portafolio. El motor de reglas es determinístico (palabras clave, cliente, prioridad, carga de trabajo). No tiene LLM. El helpdesk y la casilla de correo son adaptadores de ejemplo en memoria con datos sintéticos; no se conectó a un helpdesk ni a un servidor de correo real.

## Qué hace

| Capacidad | Comportamiento |
|-----------|----------------|
| **Propuestas por reglas** | La primera regla que coincide (por cliente, palabra clave entera, prioridad) aporta los técnicos candidatos; recibe la propuesta el que tiene menos tickets abiertos. Si ninguna coincide, se usa todo el equipo. |
| **Límites de carga** | Un técnico que llegó a `maxOpenTickets` no recibe más propuestas. Si todos los candidatos están llenos, la propuesta queda sin asignado y quien aprueba debe elegir uno. |
| **Cola de aprobación** | `approve` aplica exactamente una propuesta; `reject` exige un motivo y no cambia nada. Una propuesta se decide una sola vez; de dos aprobaciones simultáneas gana solo una. |
| **Control de propuesta vieja** | Si el ticket fue asignado o resuelto después de crear la propuesta, la aprobación se rechaza en vez de pisar el estado más nuevo. |
| **Registro de auditoría** | `proposal_created`, `proposal_approved`, `proposal_applied`, `proposal_rejected`, `apply_failed`, cada uno con actor y fecha. Triggers de SQLite bloquean `UPDATE` y `DELETE` sobre la tabla. |
| **Reporte diario** | Markdown: cantidad de pendientes / en proceso, carga por técnico, tickets sin asignar, propuestas en espera, decisiones de las últimas 24 horas. |
| **Resumen de correo** | Solo correo no leído de las últimas 48 horas, dirigido a vos (no en copia), que no viene de un remitente automático y contiene un pedido de acción. Aprobar la propuesta marca como leídos **solo los mensajes listados**. |
| **Adaptadores** | `HelpdeskAdapter` y `MailAdapter` son dos interfaces chicas (`src/ports.ts`); el motor nunca habla con un sistema concreto. |

## Inicio rápido

Requiere Node.js 20 o superior. Los comandos, la salida real de ejemplo y el formato del archivo de reglas están en [README.md](README.md#-quickstart). `npm test` corre 60 tests de Vitest: motor de reglas, cola de aprobación (decisiones dobles, aprobaciones concurrentes, tickets viejos, fallas del adaptador), auditoría de solo agregado, borde de la ventana del resumen, reporte y la CLI de punta a punta.

## Límites conocidos

- **Sin autenticación.** `--by` es un id de operador que la persona declara. La auditoría registra quién *dijo* aprobar; no prueba identidad.
- **Solo adaptadores de ejemplo.** Los adaptadores de archivo JSON son de un solo proceso (sin bloqueo de archivos). Un adaptador real de helpdesk o correo hay que escribirlo contra `src/ports.ts`; no hay ninguno incluido ni probado.
- **No es atómico entre sistemas.** La propuesta se marca aprobada en SQLite y después se aplica por el adaptador. Si el adaptador falla, la propuesta vuelve a la cola y se registra `apply_failed`. Si el proceso muere entre los dos pasos, la propuesta queda `approved` sin entrada `proposal_applied`, y hay que revisarla a mano.
- **El filtro de correo es una heurística de palabras clave.** Busca frases como "could you", "please <verbo>", "your approval" o un signo de pregunta. Se le escapan pedidos indirectos y puede incluir preguntas retóricas. Solo inglés.
- **El "solo agregado" lo imponen triggers de SQLite**, que frenan ediciones accidentales o desde la aplicación. Alguien con acceso de escritura al archivo de la base igual puede borrar los triggers.
