import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import mqtt, { MqttClient } from 'mqtt';

type TipoEvento = 'alerta' | 'riego' | 'espanto' | 'alarma' | 'luz' | 'otro';
type FiltroEvento = 'todos' | TipoEvento;

interface Medicion {
  hora: string;
  temp: number | null;
  hum: number | null;
  suelo: number;
  distancia: number | null;
}

interface Evento {
  hora: string;
  msg: string;
  tipo: TipoEvento;
  ts: number;
  icono: string;
  color: string;
}

interface ResumenEvento {
  clave: TipoEvento;
  nombre: string;
  color: string;
  icono: string;
  cantidad: number;
  porcentaje: number;
}

// ---- Tipos para las graficas ----
interface PuntoGrafica { x: number; y: number; texto: string; }

interface SerieGrafica {
  nombre: string;
  color: string;
  path: string;
  area: string;
  puntos: PuntoGrafica[];
}

interface GraficaGeom {
  series: SerieGrafica[];
  ejeY: { y: number; etiqueta: string }[];
  ejeX: { x: number; etiqueta: string }[];
  bandas: { y: number; alto: number; color: string }[];
  lineas: { y: number; etiqueta: string; color: string }[];
}

interface EntradaSerie {
  nombre: string;
  color: string;
  unidad: string;
  valores: (number | null)[];
  area?: boolean;
}

interface Tooltip {
  grafica: string;
  x: number;
  y: number;
  texto: string;
  color: string;
  bx: number;
  by: number;
  ancho: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: { '[class.claro]': "tema === 'claro'" }
})
export class App implements OnInit, OnDestroy {

  // Mismo despliegue EMQX que usa el ESP32 (puerto 8084 para WebSocket seguro)
  private brokerUrl = 'wss://j123125d.ala.eu-central-1.emqxsl.com:8084/mqtt';   // <-- CAMBIAR

  // Usuario propio del dashboard (creado en Authentication de EMQX)
  private usuario = 'esp32';
  private password = '1234567';                       // <-- CAMBIAR

  private topicSensor = 'esp32/casa01/sensor';
  private topicEstado = 'esp32/casa01/estado';
  private topicEvento = 'esp32/casa01/evento';
  private topicComando = 'esp32/casa01/comando';

  private client?: MqttClient;

  // La app es zoneless: hay que avisar a Angular cuando cambian datos
  private cdr = inject(ChangeDetectorRef);

  // Mismos valores que en el ESP32 (mantenerlos sincronizados)
  readonly umbralBajoSuelo = 30;   // ENCENDER_BAJO
  readonly umbralAltoSuelo = 55;   // APAGAR_ALTO
  readonly umbralAlarmaCm = 40;    // DIST_ALARMA_CM

  // Medidas del dibujo de las graficas (viewBox 600 x 220)
  private readonly G = { ancho: 600, alto: 220, izq: 38, der: 12, arriba: 12, abajo: 28 };

  conectadoBroker = false;
  conectadoESP32 = false;

  // Sensores
  temp: number | null = null;
  hum: number | null = null;
  suelo: number | null = null;
  distancia: number | null = null;
  presencia = false;        // ultrasonido (alarma)
  pir = false;              // HC-SR501 (espantapajaros)

  // Estado de actuadores
  luz = false;
  bomba = false;
  modoAuto = true;
  alarmaActiva = true;
  intrusion = false;
  espantoActivo = true;
  espantoMoviendo = false;

  ultimaActualizacion = '--';

  historial: Medicion[] = [];
  eventos: Evento[] = [];
  maxPuntos = 60;

  // Interfaz
  tema: 'oscuro' | 'claro' = this.leerTema();
  sonido = true;
  rangos = [20, 40, 60];
  rango = 40;
  filtro: FiltroEvento = 'todos';
  tip: Tooltip | null = null;
  private primerEstado = true;

  // Graficas
  graficaSuelo!: GraficaGeom;
  graficaClima!: GraficaGeom;
  graficaDistancia!: GraficaGeom;

  // Resumen de eventos
  readonly tiposEvento: { clave: TipoEvento; nombre: string; color: string; icono: string }[] = [
    { clave: 'alerta',  nombre: 'Alertas',        color: '#ef4444', icono: '🚨' },
    { clave: 'riego',   nombre: 'Riego',          color: '#38bdf8', icono: '💧' },
    { clave: 'espanto', nombre: 'Espantapájaros', color: '#f59e0b', icono: '🐦‍⬛' },
    { clave: 'alarma',  nombre: 'Alarma',         color: '#a78bfa', icono: '🔔' },
    { clave: 'luz',     nombre: 'Luz',            color: '#facc15', icono: '🔦' }
  ];
  resumenEventos: ResumenEvento[] = [];
  eventosFiltrados: Evento[] = [];
  totalEventos = 0;
  donaFondo = 'conic-gradient(#334155 0 100%)';
  riegoVeces = 0;
  riegoTexto = '0 s';

  ngOnInit(): void {
    this.recalcularGraficas();
    this.actualizarEventos();
    this.conectarMQTT();
  }

  conectarMQTT(): void {

    console.log('Conectando con EMQX...');

    this.client = mqtt.connect(this.brokerUrl, {
      username: this.usuario,
      password: this.password,
      protocolVersion: 4,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 3000,
      keepalive: 30,
      clientId: 'ANGULAR_DASHBOARD_' +
        Math.random().toString(16).substring(2, 10)
    });

    this.client.on('connect', () => {

      console.log('[MQTT] Conectado a EMQX');

      this.conectadoBroker = true;
      this.cdr.markForCheck();

      this.client?.subscribe(
        [this.topicSensor, this.topicEstado, this.topicEvento],
        { qos: 0 },
        (error) => {
          if (error) {
            console.error('Error en suscripcion:', error);
          } else {
            console.log('[MQTT] Suscripciones activas');
          }
        }
      );
    });

    this.client.on('reconnect', () => {
      console.log('[MQTT] Intentando reconectar...');
    });

    this.client.on('close', () => {
      console.log('[MQTT] Conexion cerrada');
      this.conectadoBroker = false;
      this.conectadoESP32 = false;
      this.cdr.markForCheck();
    });

    this.client.on('error', (error) => {
      console.error('[MQTT] Error:', error);
    });

    this.client.on('message', (topic, payload) => {

      const mensaje = payload.toString();

      try {
        const datos = JSON.parse(mensaje);

        if (topic === this.topicSensor) this.procesarSensor(datos);
        if (topic === this.topicEstado) this.procesarEstado(datos);
        if (topic === this.topicEvento) this.procesarEvento(datos);

      } catch (error) {
        console.error('Error procesando mensaje:', error);
      }

      this.cdr.markForCheck();
    });
  }

  // ---------- Utilidades ----------

  private horaCorta(d: Date): string {
    return d.toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  }

  private numeroOnull(valor: any): number | null {
    return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
  }

  private leerTema(): 'oscuro' | 'claro' {
    try {
      return localStorage.getItem('tema') === 'claro' ? 'claro' : 'oscuro';
    } catch {
      return 'oscuro';
    }
  }

  // ---------- Procesar mensajes ----------

  procesarSensor(datos: any): void {

    this.temp = this.numeroOnull(datos.temp);
    this.hum = this.numeroOnull(datos.hum);
    this.suelo = this.numeroOnull(datos.suelo);

    const d = this.numeroOnull(datos.distancia);
    this.distancia = d !== null && d >= 0 ? d : null;

    this.presencia = datos.movimiento === true;
    this.pir = datos.pir === true;

    this.ultimaActualizacion = this.horaCorta(new Date());

    this.historial.unshift({
      hora: this.ultimaActualizacion,
      temp: this.temp,
      hum: this.hum,
      suelo: this.suelo ?? 0,
      distancia: this.distancia
    });

    if (this.historial.length > this.maxPuntos) {
      this.historial.pop();
    }

    this.recalcularGraficas();
  }

  procesarEstado(datos: any): void {

    if (datos.conexion !== undefined) {
      this.conectadoESP32 = datos.conexion === 'online';
    }

    if (typeof datos.luz === 'boolean') {
      if (!this.primerEstado && datos.luz !== this.luz) {
        this.agregarEvento(datos.luz ? 'Luz encendida' : 'Luz apagada');
      }
      this.luz = datos.luz;
      this.primerEstado = false;
    }

    if (typeof datos.bomba === 'boolean') this.bomba = datos.bomba;
    if (typeof datos.auto === 'boolean') this.modoAuto = datos.auto;
    if (typeof datos.alarma === 'boolean') this.alarmaActiva = datos.alarma;

    if (typeof datos.intrusion === 'boolean') {
      if (datos.intrusion && !this.intrusion) this.beep();
      this.intrusion = datos.intrusion;
      document.title = this.intrusion ? '🚨 ALERTA - Maqueta IoT' : 'Maqueta IoT';
    }

    if (typeof datos.espanto === 'boolean') this.espantoActivo = datos.espanto;
    if (typeof datos.moviendo === 'boolean') this.espantoMoviendo = datos.moviendo;

    console.log('[ESP32] Estado:', this.conectadoESP32 ? 'ONLINE' : 'OFFLINE');
  }

  procesarEvento(datos: any): void {

    if (typeof datos.msg !== 'string') return;

    // El ESP32 manda la hora en segundos (UTC); si no es valida usamos la del navegador
    const ts = typeof datos.tiempo === 'number' && datos.tiempo > 1_600_000_000
      ? datos.tiempo * 1000
      : Date.now();

    this.agregarEvento(datos.msg, ts);
  }

  // ---------- Eventos ----------

  private clasificar(msg: string): TipoEvento {
    const m = msg.toLowerCase();
    if (m.includes('alerta')) return 'alerta';
    if (m.includes('bomba')) return 'riego';
    if (m.includes('espantapajaros') || m.includes('espantapájaros')) return 'espanto';
    if (m.includes('alarma')) return 'alarma';
    if (m.includes('luz')) return 'luz';
    return 'otro';
  }

  private agregarEvento(msg: string, ts: number = Date.now()): void {
    const tipo = this.clasificar(msg);
    const meta = this.tiposEvento.find(t => t.clave === tipo);

    this.eventos.unshift({
      hora: this.horaCorta(new Date(ts)),
      msg,
      tipo,
      ts,
      icono: meta?.icono ?? '•',
      color: meta?.color ?? '#94a3b8'
    });

    if (this.eventos.length > 200) {
      this.eventos.pop();
    }

    this.actualizarEventos();
  }

  private actualizarEventos(): void {

    const total = this.eventos.filter(e => e.tipo !== 'otro').length;
    this.totalEventos = total;

    this.resumenEventos = this.tiposEvento.map(t => {
      const cantidad = this.eventos.filter(e => e.tipo === t.clave).length;
      return {
        ...t,
        cantidad,
        porcentaje: total > 0 ? Math.round((cantidad * 100) / total) : 0
      };
    });

    // Dona: gradiente conico con un tramo por tipo de evento
    if (total === 0) {
      this.donaFondo = 'conic-gradient(#334155 0 100%)';
    } else {
      let acumulado = 0;
      const partes: string[] = [];
      for (const r of this.resumenEventos) {
        if (r.cantidad === 0) continue;
        const desde = acumulado;
        acumulado += (r.cantidad / total) * 100;
        partes.push(`${r.color} ${desde}% ${acumulado}%`);
      }
      this.donaFondo = `conic-gradient(${partes.join(', ')})`;
    }

    // Veces y tiempo total de riego (pares "encendida" -> "apagada")
    let veces = 0;
    let segundos = 0;
    let inicio: number | null = null;
    for (const e of [...this.eventos].reverse()) {
      if (e.tipo !== 'riego') continue;
      const m = e.msg.toLowerCase();
      if (m.includes('encendida')) {
        veces++;
        inicio = e.ts;
      } else if (m.includes('apagada') && inicio !== null) {
        segundos += (e.ts - inicio) / 1000;
        inicio = null;
      }
    }
    const s = Math.round(segundos);
    this.riegoVeces = veces;
    this.riegoTexto = s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;

    this.eventosFiltrados = this.eventos
      .filter(e => this.filtro === 'todos' || e.tipo === this.filtro)
      .slice(0, 40);
  }

  cambiarFiltro(f: FiltroEvento): void {
    this.filtro = f;
    this.actualizarEventos();
  }

  // ---------- Comandos ----------

  private enviarComando(comando: Record<string, boolean>): void {

    if (!this.client?.connected) {
      console.error('No hay conexion con EMQX');
      return;
    }

    this.client.publish(
      this.topicComando,
      JSON.stringify(comando),
      { qos: 1, retain: false },
      (error) => {
        if (error) {
          console.error('Error enviando comando:', error);
        } else {
          console.log('[CMD] Enviado:', comando);
        }
      }
    );
  }

  // Deja el interruptor como estaba; solo cambia cuando el ESP32 confirma el estado
  private revertir(ev: Event, valor: boolean): void {
    (ev.target as HTMLInputElement).checked = valor;
  }

  cambiarLuz(ev: Event): void {
    this.revertir(ev, this.luz);
    this.enviarComando({ luz: !this.luz });
  }

  cambiarAuto(ev: Event): void {
    this.revertir(ev, this.modoAuto);
    this.enviarComando({ auto: !this.modoAuto });
  }

  cambiarAlarma(ev: Event): void {
    this.revertir(ev, this.alarmaActiva);
    this.enviarComando({ alarma: !this.alarmaActiva });
  }

  cambiarEspanto(ev: Event): void {
    this.revertir(ev, this.espantoActivo);
    this.enviarComando({ espanto: !this.espantoActivo });
  }

  cambiarBomba(): void {
    if (this.modoAuto) return;
    this.enviarComando({ bomba: !this.bomba });
  }

  confirmarAlerta(): void {
    this.enviarComando({ ack: true });
  }

  // ---------- Interfaz ----------

  cambiarTema(): void {
    this.tema = this.tema === 'oscuro' ? 'claro' : 'oscuro';
    try {
      localStorage.setItem('tema', this.tema);
    } catch { /* sin almacenamiento disponible */ }
  }

  cambiarRango(n: number): void {
    this.rango = n;
    this.recalcularGraficas();
  }

  private beep(): void {
    if (!this.sonido) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch { /* el navegador bloqueo el audio */ }
  }

  descargarCSV(): void {
    const filas = [
      'hora,temperatura,humedad,suelo,distancia',
      ...[...this.historial].reverse().map(d =>
        `${d.hora},${d.temp ?? ''},${d.hum ?? ''},${d.suelo},${d.distancia ?? ''}`)
    ];
    const blob = new Blob([filas.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maqueta-lecturas.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Indicadores calculados (devuelven texto, no objetos)
  get estadoSuelo(): string {
    if (this.suelo === null) return 'sin-dato';
    if (this.suelo < this.umbralBajoSuelo) return 'seco';
    if (this.suelo > this.umbralAltoSuelo) return 'humedo';
    return 'ok';
  }

  get textoSuelo(): string {
    switch (this.estadoSuelo) {
      case 'seco': return 'Seca: necesita riego';
      case 'humedo': return 'Muy húmeda';
      case 'ok': return 'Humedad óptima';
      default: return 'Sin dato';
    }
  }

  get cercania(): number {
    if (this.distancia === null) return 0;
    return Math.max(0, Math.min(100, 100 - this.distancia / 2));
  }

  // ---------- Graficas ----------

  mostrarTip(grafica: string, p: PuntoGrafica, color: string): void {
    const ancho = Math.min(p.texto.length * 5.8 + 14, 280);
    const bx = Math.min(Math.max(p.x - ancho / 2, 4), 596 - ancho);
    const by = p.y - 34 < 4 ? p.y + 10 : p.y - 34;
    this.tip = { grafica, x: p.x, y: p.y, texto: p.texto, color, bx, by, ancho };
  }

  ocultarTip(): void {
    this.tip = null;
  }

  private recalcularGraficas(): void {

    // El historial guarda lo mas nuevo primero; la grafica necesita orden cronologico
    const datos = this.historial.slice(0, this.rango).reverse();
    const horas = datos.map(d => d.hora);

    this.graficaSuelo = this.construirGrafica(
      [{ nombre: 'Tierra', color: '#22c55e', unidad: '%', area: true,
         valores: datos.map(d => d.suelo) }],
      horas, 0, 100,
      [
        { desde: 0, hasta: this.umbralBajoSuelo, color: 'rgba(239,68,68,0.15)' },
        { desde: this.umbralBajoSuelo, hasta: this.umbralAltoSuelo, color: 'rgba(34,197,94,0.12)' }
      ]
    );

    this.graficaClima = this.construirGrafica(
      [
        { nombre: 'Temperatura', color: '#f59e0b', unidad: '°C', valores: datos.map(d => d.temp) },
        { nombre: 'Humedad aire', color: '#38bdf8', unidad: '%', valores: datos.map(d => d.hum) }
      ],
      horas, 0, 100
    );

    const maxDist = Math.max(100, ...datos.map(d => d.distancia ?? 0));
    this.graficaDistancia = this.construirGrafica(
      [{ nombre: 'Distancia', color: '#a78bfa', unidad: 'cm',
         valores: datos.map(d => d.distancia) }],
      horas, 0, Math.ceil(maxDist / 50) * 50,
      [],
      [{ valor: this.umbralAlarmaCm, etiqueta: 'Umbral alarma', color: '#ef4444' }]
    );
  }

  private construirGrafica(
    entradas: EntradaSerie[],
    horas: string[],
    min: number,
    max: number,
    bandas: { desde: number; hasta: number; color: string }[] = [],
    lineas: { valor: number; etiqueta: string; color: string }[] = []
  ): GraficaGeom {

    const { ancho, alto, izq, der, arriba, abajo } = this.G;
    const w = ancho - izq - der;
    const h = alto - arriba - abajo;
    const n = horas.length;
    const rango = Math.max(max - min, 1);

    const redondear = (v: number) => Math.round(v * 10) / 10;
    const px = (i: number) => n <= 1 ? izq + w / 2 : izq + (i / (n - 1)) * w;
    const py = (v: number) => {
      const c = Math.min(Math.max(v, min), max);
      return arriba + h - ((c - min) / rango) * h;
    };

    const series: SerieGrafica[] = entradas.map(e => {
      let path = '';
      let enTrazo = false;
      const puntos: PuntoGrafica[] = [];

      e.valores.forEach((v, i) => {
        if (v === null) {            // hueco: la linea se corta
          enTrazo = false;
          return;
        }
        const x = redondear(px(i));
        const y = redondear(py(v));
        path += `${enTrazo ? 'L' : 'M'}${x},${y} `;
        enTrazo = true;
        const valorTexto = Number.isInteger(v) ? `${v}` : v.toFixed(1);
        puntos.push({ x, y, texto: `${horas[i]} · ${e.nombre}: ${valorTexto} ${e.unidad}` });
      });

      let area = '';
      if (e.area && puntos.length > 1 && !e.valores.includes(null)) {
        const base = arriba + h;
        area = `${path}L${puntos[puntos.length - 1].x},${base} L${puntos[0].x},${base} Z`;
      }

      return { nombre: e.nombre, color: e.color, path: path.trim(), area, puntos };
    });

    const ejeY = [0, 1, 2, 3, 4].map(i => {
      const valor = min + ((max - min) * i) / 4;
      return { y: redondear(py(valor)), etiqueta: `${Math.round(valor)}` };
    });

    let indicesX: number[] = [];
    if (n === 1) {
      indicesX = [0];
    } else if (n > 1) {
      indicesX = [...new Set([
        0,
        Math.round((n - 1) / 3),
        Math.round((2 * (n - 1)) / 3),
        n - 1
      ])];
    }
    const ejeX = indicesX.map(i => ({ x: redondear(px(i)), etiqueta: horas[i] }));

    const bandasPx = bandas.map(b => {
      const y1 = py(b.hasta);
      const y2 = py(b.desde);
      return { y: redondear(y1), alto: redondear(y2 - y1), color: b.color };
    });

    const lineasPx = lineas.map(l => ({
      y: redondear(py(l.valor)),
      etiqueta: l.etiqueta,
      color: l.color
    }));

    return { series, ejeY, ejeX, bandas: bandasPx, lineas: lineasPx };
  }

  ngOnDestroy(): void {
    if (this.client) {
      this.client.end();
      console.log('[MQTT] Cliente desconectado');
    }
  }
}