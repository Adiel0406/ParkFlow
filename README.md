# ParkFlow Beta — Registro de parqueo

## Ejecutar
Abre la carpeta del proyecto en Visual Studio Code y sirve `index.html` con Live Server (o con cualquier servidor web local). Es recomendable usar el mismo origen para que las páginas compartan los datos guardados en `localStorage`. No necesita librerías.

## Estructura de carpetas
```text
ParqueoBeta/
├── index.html
├── vehicles.html
├── spaces.html
├── tariff.html
├── layout.html
├── assets/parking.svg
├── css/
│   ├── base.css
│   ├── components.css
│   ├── pages.css
│   ├── themes.css
│   └── responsive.css
├── js/
│   ├── state.js
│   ├── views.js
│   └── app.js
└── README.md
```

`index.html` contiene el resumen y el formulario de ingreso; `vehicles.html` permite buscar vehículos, emitir facturas y registrar salidas; `spaces.html` muestra el mapa y la cola de confirmación de salida; `tariff.html` permite modificar tarifas e intervalos; `layout.html` permite diseñar el parqueo. Los archivos JavaScript se cargan en este orden: primero el estado y las estructuras, luego el renderizado y finalmente los eventos.

En «Armar parqueo» se configuran hasta 5 subsuelos y 10 niveles desde la planta baja, con una cuadrícula de hasta 20 × 20 por piso. Se pueden dibujar espacios, pasillos, entradas, rampas, rampas circulares y celdas vacías. La capacidad se calcula a partir de las celdas marcadas como espacio. Para guardar cambios en el plano, todos los vehículos deben haber registrado su salida. El diseño y los datos se guardan en el mismo `localStorage`.

El tarifario es común a todos los tipos de vehículo y se configura en «Tarifario» con rangos «De / Hasta», cada límite expresado en minutos u horas, y un monto fijo en bolivianos. El primer rango inicia en 0; los demás comienzan exactamente donde termina el rango anterior y deben tener un límite final mayor. Se cobra el monto fijo del rango en que cae la estadía; al superar el último límite, se mantiene el monto del último rango. Los extremos superiores son inclusivos, por lo que un tiempo exactamente igual al límite se cobra con el rango que termina en ese límite. Por defecto, los rangos son de 0 a 30 min por Bs 2,50, de 30 a 60 min por Bs 2,50 y de 60 a 120 min por Bs 5,00. La configuración se conserva en `localStorage`. Al pulsar «Ver factura» en «Vehículos» se muestra el rango y monto antes de confirmar el pago y se pueden ingresar NIT, nombre y correo, todos opcionales. Cancelar requiere confirmación y no registra el pago. Después de confirmar el cobro, el vehículo entra en la cola de salida por 10 minutos. Si no se confirma la salida en ese plazo, se solicita un nuevo cobro calculado desde el ingreso original.

El logo `assets/parking.svg` se usa como identidad visual y favicon. La interfaz se adapta a escritorio, tabletas y celulares mediante `css/responsive.css`; en pantallas pequeñas la navegación se coloca arriba del contenido y las tablas pueden desplazarse horizontalmente.

El formulario valida placas con el formato `NNNN-LLL` o `NNNNN-LLL` (N: dígito, L: letra; se guardan en mayúsculas). Para registrar un vehículo solicita tipo, marca y color; las marcas conocidas aparecen en una lista y se puede escribir una marca distinta con «Otra marca». Conductor y observaciones ya no forman parte del formulario.

El botón «Modo oscuro» de la navegación cambia el tema en todas las páginas y conserva la preferencia en `localStorage`.

## Estructuras implementadas y por qué

- **Arreglos — vehículos activos, historial, pisos y celdas.** Son apropiados porque la aplicación recorre y muestra estos datos con frecuencia, los persiste fácilmente como JSON en `localStorage` y trabaja con colecciones acotadas. Agregar al final suele ser O(1) amortizado; buscar o eliminar por valor es O(n). El historial conserva como máximo 50 eventos.
- **`Map` — consultas por placa y espacio.** Se usa para comprobar placas activas y relacionar espacios con vehículos. Consultar una clave tiene costo promedio O(1), pero los mapas se reconstruyen desde los vehículos en cada operación: construirlos cuesta O(n). Por eso, no se presenta como una mejora global de O(1), sino como un índice conveniente para las consultas por clave.
- **`Set` — validación de la configuración del plano.** Comprueba que los tipos de celda permitidos sean válidos y que no se repitan los identificadores de piso. Es adecuado para validar pertenencia y unicidad, con costo promedio O(1) por consulta.
- **Pila (LIFO) — deshacer la última salida.** La última salida guarda temporalmente la información del vehículo y del pago; al deshacer, se recupera esa salida conservando el `paidAt` original. Así vuelve al estado de confirmación con solo el tiempo que le quedaba dentro de los 10 minutos.

El cobro no se registra mientras la factura está abierta. Si se cancela y se confirma la cancelación, el vehículo queda pendiente y no se agrega un evento de pago al historial. La pila de salidas permite restaurar el pago original y su hora, sin reiniciar el contador de 10 minutos.

El historial se mantiene como arreglo y se representa directamente desde ese arreglo en `js/views.js`. No se construye una lista enlazada temporal: para este caso, la lista enlazada agregaba nodos y recorridos sin aportar una ventaja frente al arreglo, que ya es la estructura persistida y consultada.

La tabla de vehículos se filtra y ordena una copia, sin modificar los datos originales. Ordenar cuesta típicamente O(n log n); la búsqueda por texto es O(n).

## Búsqueda y notación Big O
- Búsqueda por placa: O(n) total al reconstruir el `Map` desde los vehículos activos; consultar la clave dentro del `Map` es O(1) promedio.
- Búsqueda por texto libre (placa, marca, color o tipo): O(n), porque se revisan registros.
- Encontrar un espacio libre: O(n + m), donde `n` es el número de vehículos para construir el índice y `m` el número de espacios que se revisan.
- Ordenar registros para mostrarlos: O(n log n).
- No se usa un algoritmo O(n²) intencionalmente; se evita comparar cada registro contra todos los demás.

`n` representa la cantidad de vehículos o eventos. Big O explica cómo crece el trabajo al aumentar la entrada; no mide segundos exactos.

## Por qué no se usa recursividad, árboles o grafos
No se añadieron solo para contar estructuras: el flujo actual no los necesita. Una futura ampliación podría usar un árbol binario de búsqueda para indexar placas, o un grafo para representar rutas entre sectores del estacionamiento. Recursividad sería útil si se recorriera un árbol de forma recursiva, pero no aporta una ventaja clara en esta versión.

## Límites
- Guarda datos en `localStorage`, solo en ese navegador/dispositivo.
- No usa servidor ni base de datos compartida.
- Es una beta académica, no un sistema de cobro o auditoría listo para producción.
