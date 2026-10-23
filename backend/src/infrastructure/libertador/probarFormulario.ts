/**
 * Prueba el llenado del formulario de solicitud de documentos sin pasar por el
 * Huella ni por Drive: los datos del caso van por la línea de comandos.
 *
 *   npm run libertador:formulario -- <url> <solicitud> <poliza> <estado> <ciudad>
 *       muestra lo que se mandaría; NO envía nada
 *   npm run libertador:formulario -- <url> <solicitud> <poliza> <estado> <ciudad> --enviar
 *       lo envía de verdad (usar con la copia de prueba, no con el de Bolívar)
 *
 * Los valores fijos (correo, abogado, despacho…) salen de backend/.env igual que
 * en producción: ver formularioSolicitud.ts.
 */
import 'dotenv/config';
import { leerFormulario, armarRespuesta, enviarFormulario, textoDelEnvio } from './formularioSolicitud';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const enviar = args.includes('--enviar');
  const [url, solicitud, poliza, estado, ciudad] = args.filter((a) => a !== '--enviar');
  if (!ciudad) {
    console.error('Uso: npm run libertador:formulario -- <url> <solicitud> <poliza> <estado> <ciudad> [--enviar]');
    process.exit(1);
  }

  const form = await leerFormulario(url);
  console.log(`${form.titulo} — ${form.paginas} página(s), ${form.preguntas.length} pregunta(s), correo: ${form.correo}\n`);
  const pares = armarRespuesta(form, { solicitud, poliza, estado, ciudad });
  console.log(textoDelEnvio(form, pares).replace(/^Enviado: .*\n/m, ''));

  if (!enviar) {
    console.log('(No se envió nada. Agrega --enviar para mandarlo.)');
    return;
  }
  await enviarFormulario(form, pares);
  console.log('✓ Enviado. Revisa la pestaña "Respuestas" del formulario.');
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
