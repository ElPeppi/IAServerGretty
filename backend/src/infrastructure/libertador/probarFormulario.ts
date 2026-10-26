/**
 * Arma el enlace prellenado del formulario de solicitud de documentos para un
 * caso, sin pasar por el Huella ni por Drive: los datos van por la línea de
 * comandos. Sirve para mandarlo a mano (abrir el enlace → Siguiente → Enviar).
 *
 *   npm run libertador:formulario -- <solicitud> <poliza> <estado> <ciudad> [url]
 *
 * Sin [url] usa el formulario de Bolívar (o LIBERTADOR_FORM_URL). Los valores fijos
 * (correo, abogado, despacho…) salen de backend/.env igual que en producción: ver
 * formularioSolicitud.ts. No envía nada: el "Enviar" lo da una persona.
 */
import 'dotenv/config';
import { configFormulario, leerFormulario, armarRespuesta, enlacePrellenado, textoDeRespuestas } from './formularioSolicitud';

async function main(): Promise<void> {
  const [solicitud, poliza, estado, ciudad, url] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!ciudad) {
    console.error('Uso: npm run libertador:formulario -- <solicitud> <poliza> <estado> <ciudad> [url]');
    process.exit(1);
  }

  const form = await leerFormulario(url || configFormulario().url);
  console.log(`${form.titulo} — ${form.paginas} página(s), ${form.preguntas.length} pregunta(s)\n`);
  const pares = armarRespuesta(form, { solicitud, poliza, estado, ciudad });
  console.log(textoDeRespuestas(form, pares));
  console.log(`\nEnlace (ábrelo en incógnito para que el correo venga puesto; luego Siguiente y Enviar):\n${enlacePrellenado(form, pares)}`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
