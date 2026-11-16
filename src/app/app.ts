import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import mqtt, { MqttClient } from 'mqtt';

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
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {

  // Mismo despliegue EMQX que usa el ESP32 (puerto 8084 para WebSocket seguro)
  private brokerUrl = 'wss://TU_HOST.emqxsl.com:8084/mqtt';   // <-- CAMBIAR

  // Usuario propio del dashboard (creado en Authentication de EMQX)
  private usuario = 'dashboard';
  private password = 'CLAVE_DASHBOARD';                       // <-- CAMBIAR

  private topicSensor = 'esp32/casa01/sensor';
  private topicEstado = 'esp32/casa01/estado';
  private topicEvento = 'esp32/casa01/evento';
  private topicComando = 'esp32/casa01/comando';

  private client?: MqttClient;

  // La app es zoneless: hay que avisar a Angular cuando cambian datos
  private cdr = inject(ChangeDetectorRef);

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

  ngOnInit(): void {
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

  // ---------- Procesar mensajes ----------

  private numeroOnull(valor: any): number | null {
    return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
  }

  procesarSensor(datos: any): void {

    this.temp = this.numeroOnull(datos.temp);
    this.hum = this.numeroOnull(datos.hum);
    this.suelo = this.numeroOnull(datos.suelo);

    const d = this.numeroOnull(datos.distancia);
    this.distancia = d !== null && d >= 0 ? d : null;

    this.presencia = datos.movimiento === true;
    this.pir = datos.pir === true;

    this.ultimaActualizacion = new Date().toLocaleTimeString();

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
  }

  procesarEstado(datos: any): void {

    if (datos.conexion !== undefined) {
      this.conectadoESP32 = datos.conexion === 'online';
    }

    if (typeof datos.luz === 'boolean') this.luz = datos.luz;
    if (typeof datos.bomba === 'boolean') this.bomba = datos.bomba;
    if (typeof datos.auto === 'boolean') this.modoAuto = datos.auto;
    if (typeof datos.alarma === 'boolean') this.alarmaActiva = datos.alarma;
    if (typeof datos.intrusion === 'boolean') this.intrusion = datos.intrusion;
    if (typeof datos.espanto === 'boolean') this.espantoActivo = datos.espanto;
    if (typeof datos.moviendo === 'boolean') this.espantoMoviendo = datos.moviendo;

    console.log('[ESP32] Estado:', this.conectadoESP32 ? 'ONLINE' : 'OFFLINE');
  }

  procesarEvento(datos: any): void {

    if (typeof datos.msg !== 'string') return;

    this.eventos.unshift({
      hora: new Date().toLocaleTimeString(),
      msg: datos.msg
    });

    if (this.eventos.length > 30) {
      this.eventos.pop();
    }
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

  cambiarLuz(): void {
    this.enviarComando({ luz: !this.luz });
  }

  cambiarAuto(): void {
    this.enviarComando({ auto: !this.modoAuto });
  }

  cambiarBomba(): void {
    if (this.modoAuto) return;
    this.enviarComando({ bomba: !this.bomba });
  }

  cambiarAlarma(): void {
    this.enviarComando({ alarma: !this.alarmaActiva });
  }

  cambiarEspanto(): void {
    this.enviarComando({ espanto: !this.espantoActivo });
  }

  confirmarAlerta(): void {
    this.enviarComando({ ack: true });
  }

  // ---------- Graficas (polyline SVG) ----------

  private construirPuntos(valores: number[], minFijo?: number, maxFijo?: number): string {

    if (valores.length === 0) return '';

    const minimo = minFijo ?? Math.min(...valores);
    const maximo = maxFijo ?? Math.max(...valores);
    const rango = Math.max(maximo - minimo, 5);

    return valores.map((valor, index) => {

      const x = valores.length === 1
        ? 300
        : 20 + (index / (valores.length - 1)) * 560;

      const y = 190 - ((valor - minimo) / rango) * 160;

      return `${x},${y}`;

    }).join(' ');
  }

  get puntosSuelo(): string {
    const valores = [...this.historial].reverse().map(d => d.suelo);
    return this.construirPuntos(valores, 0, 100);
  }

  get puntosTemp(): string {
    const valores = [...this.historial]
      .reverse()
      .filter(d => d.temp !== null)
      .map(d => d.temp as number);
    return this.construirPuntos(valores);
  }

  ngOnDestroy(): void {
    if (this.client) {
      this.client.end();
      console.log('[MQTT] Cliente desconectado');
    }
  }
}