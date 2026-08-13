import { Response } from 'express';
import { storage } from '../../infrastructure/storage';
import { BANCO_DEFAULT, CARPETA_PROCESO, unir, type Proceso } from '../../infrastructure/storage/rutas';
import { carpetasDeCedula } from '../../infrastructure/storage/carpetasCedula';
import { correosPoderDisponibles } from '../../infrastructure/storage/correosPoder';
import { obtenerDatoManual, guardarDatoManual } from '../../application/services/datosManuales';
import { AuthRequest } from '../middlewares/authMiddleware';

/**
 * ExpedienteController — los documentos que tiene un cliente en el servidor.
 *
 * Existe porque en Drive la oficina NO puede administrar estos archivos: viven en
 * "Mi unidad" y su dueño es la cuenta que los subió (`servidor@`), así que a un
 * editor Drive solo le ofrece "Quitar de la vista" —que no borra, y encima deja el
 * archivo huérfano fuera de su carpeta—. El backend actúa COMO esa cuenta, de modo
 * que desde aquí sí se pueden ver y borrar de verdad.
 */

/** Tipo de documento, deducido del nombre. Ordena y agrupa la vista. */
function clasificar(nombre: string): string {
  if (/^SAC_.*DIRYTEL/i.test(nombre)) return 'SAC';
  if (/^SAC_.*RUNT/i.test(nombre)) return 'RUNT';
  if (/^SAC_/i.test(nombre)) return 'SAC';
  if (/^CONTACTOS_/i.test(nombre)) return 'CONTACTOS';
  if (/DATACREDITO/i.test(nombre)) return 'DATACREDITO';
  if (/(PAGARE|DECEVAL)/i.test(nombre)) return 'PAGARE';
  if (/^DEMANDA/i.test(nombre)) return 'DEMANDA';
  if (/^ANEXOS/i.test(nombre)) return 'ANEXOS';
  if (/^ANTECEDENTES/i.test(nombre)) return 'ANTECEDENTES';
  if (/^PODER/i.test(nombre)) return 'PODER';
  return 'OTRO';
}

const procesoDe = (v: unknown): Proceso =>
  String(v) === 'pago_directo' ? 'pago_directo' : 'singular';

export class ExpedienteController {
  /**
   * GET /api/expedientes/_correos-poder?banco=&proceso=
   * Correos del banco que otorgan el poder (ANEXO 1) que YA están en el servidor,
   * del más reciente al más viejo. Sirve para elegir uno en vez de volver a subirlo.
   */
  async correosPoder(req: AuthRequest, res: Response): Promise<void> {
    try {
      const banco = String(req.query['banco'] || BANCO_DEFAULT);
      const proceso = procesoDe(req.query['proceso']);
      res.json({ correos: await correosPoderDisponibles(banco, proceso) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al listar los correos de poder';
      res.status(500).json({ message });
    }
  }

  /**
   * GET /api/expedientes/:cedula/datos-manuales
   * Lo que se capturó a mano del pagaré de esa cédula (nº y fecha de suscripción).
   */
  async verDatosManuales(req: AuthRequest, res: Response): Promise<void> {
    try {
      const dato = await obtenerDatoManual(String(req.params['cedula'] ?? ''));
      res.json({
        numeroPagare: dato?.numeroPagare ?? '',
        fechaSuscripcion: dato?.fechaSuscripcion ?? '',
        nota: dato?.nota ?? '',
        actualizadoAt: dato?.updatedAt ?? null,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al leer los datos capturados a mano';
      res.status(500).json({ message });
    }
  }

  /**
   * PUT /api/expedientes/:cedula/datos-manuales
   * Guarda el nº de pagaré / la fecha de suscripción que el OCR no puede leer del
   * pagaré escaneado. Mandan sobre el motor en la próxima generación. Vaciar un
   * campo lo borra (vuelve a lo que lea el motor).
   */
  async guardarDatosManuales(req: AuthRequest, res: Response): Promise<void> {
    try {
      const cedula = String(req.params['cedula'] ?? '');
      const dato = await guardarDatoManual(
        cedula,
        {
          numeroPagare: req.body?.numeroPagare,
          fechaSuscripcion: req.body?.fechaSuscripcion,
          nota: req.body?.nota,
        },
        req.user?.userId
      );
      res.json({
        numeroPagare: dato.numeroPagare ?? '',
        fechaSuscripcion: dato.fechaSuscripcion ?? '',
        nota: dato.nota ?? '',
        actualizadoAt: dato.updatedAt,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al guardar';
      // Cédula o fecha inválida = dato del usuario, no falla del servidor.
      res.status(/inválid/i.test(message) ? 400 : 500).json({ message });
    }
  }

  /**
   * GET /api/expedientes/:cedula?banco=&proceso=
   * Carpetas del cliente (puede tener varias, de asignaciones distintas) con sus
   * archivos. Si no se pide un proceso, se buscan los DOS.
   */
  async ver(req: AuthRequest, res: Response): Promise<void> {
    try {
      const cedula = String(req.params['cedula'] ?? '').replace(/\D/g, '');
      if (!/^\d{5,12}$/.test(cedula)) {
        res.status(400).json({ message: 'Cédula inválida (5 a 12 dígitos).' });
        return;
      }
      if (!storage.enabled) {
        res.status(400).json({ message: 'El almacenamiento no está configurado.' });
        return;
      }
      const banco = String(req.query['banco'] || BANCO_DEFAULT);
      const procesos: Proceso[] = req.query['proceso']
        ? [procesoDe(req.query['proceso'])]
        : (Object.keys(CARPETA_PROCESO) as Proceso[]);

      // Cada proceso son varias llamadas a Drive (bajar por el árbol + listar la
      // carpeta). En serie se sentía lento, así que van en paralelo.
      const porProceso = await Promise.all(
        procesos.map(async (proceso) => {
          const suyas = await carpetasDeCedula(cedula, banco, proceso);
          return Promise.all(
            suyas.map(async (c) => ({
              proceso,
              procesoNombre: CARPETA_PROCESO[proceso],
              nombre: c.nombre,
              relPath: c.relPath,
              archivos: (await storage.list(c.relPath))
                .map((nombre) => ({
                  nombre,
                  relPath: unir(c.relPath, nombre),
                  url: storage.urlFor(unir(c.relPath, nombre)),
                  tipo: clasificar(nombre),
                }))
                .sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nombre.localeCompare(b.nombre)),
            })),
          );
        }),
      );
      const carpetas = porProceso.flat();

      res.json({ cedula, banco, carpetas, total: carpetas.reduce((n, c) => n + c.archivos.length, 0) });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al leer el expediente';
      res.status(500).json({ message });
    }
  }

  /**
   * DELETE /api/expedientes/:cedula/archivo   { relPath }
   * Borra un archivo del cliente. El relPath debe caer DENTRO de una carpeta suya:
   * así un relPath manipulado no puede borrar nada de otro cliente ni las plantillas.
   */
  async borrarArchivo(req: AuthRequest, res: Response): Promise<void> {
    try {
      const cedula = String(req.params['cedula'] ?? '').replace(/\D/g, '');
      const relPath = String(req.body?.relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!/^\d{5,12}$/.test(cedula) || !relPath) {
        res.status(400).json({ message: 'Faltan cédula o relPath.' });
        return;
      }
      if (!storage.enabled) {
        res.status(400).json({ message: 'El almacenamiento no está configurado.' });
        return;
      }
      const banco = String(req.query['banco'] || BANCO_DEFAULT);

      // El archivo tiene que estar en una carpeta DE ESTA cédula (cualquier proceso).
      const permitidas: string[] = [];
      for (const proceso of Object.keys(CARPETA_PROCESO) as Proceso[]) {
        for (const c of await carpetasDeCedula(cedula, banco, proceso)) permitidas.push(c.relPath);
      }
      const dentro = permitidas.some(
        (base) => relPath.startsWith(`${base}/`) && !relPath.slice(base.length + 1).includes('/'),
      ); // solo archivos sueltos de la carpeta, no subcarpetas
      if (!dentro) {
        res.status(403).json({ message: 'Ese archivo no pertenece al expediente de esta cédula.' });
        return;
      }

      // `delete` es opcional en IStorage (no todos los backends lo implementan).
      if (!storage.delete) {
        res.status(501).json({ message: 'El almacenamiento configurado no permite borrar archivos.' });
        return;
      }
      await storage.delete(relPath);
      console.error(`[expedientes] ${req.user?.userId} borró "${relPath}"`);
      res.json({ success: true, relPath });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Error al borrar el archivo';
      res.status(500).json({ message });
    }
  }
}
