# Roadmap: Agente IA y evolución a microservicios

Nota de arquitectura (decisión pendiente, no implementada). Recoge la discusión sobre
dos ideas para cuando el proyecto escale a más tipos de demanda y automatización.

## Estado actual

- 3 piezas: **motor** (`sac_scripts`, Node), **backend** (Express + Prisma + Postgres),
  **frontend** (React/Vite).
- El motor ya decide por **reglas fijas** (DECEVAL vs FINANDINA, qué anexo buscar,
  si el proceso es ejecutivo singular). Es un "agente sin IA".
- Firma: demanda `.docx` → PDF (LibreOffice headless) + anexos → un solo PDF en
  `{NAS}/{cedula}/DEMANDA FIRMADA - {cedula}.pdf`. **Los antecedentes NO van en la
  firmada** (se radican por separado).

## 1. Agente IA (tool calling)

**Objetivo:** poder escribirle en lenguaje natural y que decida qué acción ejecutar,
a dónde mandar la solicitud y con qué información.

**Patrón:** *tool calling* / function calling (estándar con Claude).

1. Se definen "herramientas" = las acciones existentes (generar demanda singular,
   buscar anexo, mandar correo a tránsito/SIJIN, radicar, etc.), cada una con nombre,
   parámetros y descripción.
2. Al modelo se le pasan las herramientas + el texto del usuario.
3. El modelo decide **cuál** herramienta y **con qué datos** (devuelve `{tool, args}`).
4. El código ejecuta la herramienta. Loop hasta terminar.

**Ventaja:** reemplaza reglas rígidas por decisión flexible; envuelve lo que YA existe.

**Riesgos y mitigación:**
- Alucinación → el agente **propone**, el humano **confirma** (mismo patrón que el
  popup de firma ya existente).
- Datos sensibles (cédulas, financieros) → controlar qué se envía a la API.
- Costo por token (bajo vs. horas de abogado).

**Esfuerzo:** 1 endpoint + envolver 5–10 acciones actuales como tools. Empezar chico
(un chat que dispare la generación singular). Semanas, no meses.

## 2. Microservicios

**Objetivo al escalar:** cada tipo de demanda (singular, hipotecario, …) como servicio
independiente; el motor/agente solo sabe "llamar a X con estos datos", no el cómo.

**Recomendación: destino correcto, pero por evolución — no big-bang.**

- **Ahora:** monolito **modular**. Dentro del motor, separar cada tipo de demanda en
  módulos/carpetas con la **misma interfaz**: `generar(datos) → resultado`. Barato y
  ya da el orden.
- **Después:** cuando un tipo necesite escalar o desplegarse por separado, se **extrae**
  ese módulo a un servicio. La interfaz limpia hace el corte trivial.
- **El agente encaja encima:** sus tools = esos módulos/servicios. Da igual si son
  función local o HTTP remoto — misma firma.

**Regla:** diseñar las fronteras (interfaces) hoy; partir en servicios cuando el dolor
lo justifique (equipo grande, escalado dispar, despliegues que chocan). Microservicios
prematuros = complejidad sin pago.

## Resumen

- **Agente IA:** factible ya; empezar chico, con confirmación humana.
- **Microservicios:** llegar por evolución (módulos con interfaz limpia → extraer).
- Ambos encajan: agente llama tools = módulos = futuros servicios.
