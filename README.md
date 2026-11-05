# ParkFlow Beta — Registro de parqueo

## Ejecutar
Abre la carpeta del proyecto en Visual Studio Code y sirve `index.html` con Live Server (o con cualquier servidor web local). Es recomendable usar el mismo origen para que las páginas compartan los datos guardados en `localStorage`. No necesita librerías.

## Estructura de carpetas
```text
ParqueoBeta/
├── index.html
├── vehicles.html
├── spaces.html
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

`index.html` contiene el resumen y el formulario de ingreso; `vehicles.html` permite buscar vehículos, cobrar estadías y registrar salidas; `spaces.html` muestra el mapa, el tarifario y la cola de confirmación de salida; `layout.html` permite diseñar el parqueo. Los archivos JavaScript se cargan en este orden: primero el estado y las estructuras, luego el renderizado y finalmente los eventos.

En «Armar parqueo» se configuran hasta 5 subsuelos y 10 niveles desde la planta baja, con una cuadrícula de hasta 20 × 20 por piso. Se pueden dibujar espacios, pasillos, entradas, rampas, rampas circulares y celdas vacías. La capacidad se calcula a partir de las celdas marcadas como espacio. Para guardar cambios en el plano, todos los vehículos deben haber registrado su salida. El diseño y los datos se guardan en el mismo `localStorage`.

La estadía se cobra por hora iniciada, con mínimo de una hora: Bs 3 para motocicletas, Bs 5 para automóviles y Bs 7 para camionetas y SUV. Después del pago, el vehículo permanece ocupando su espacio y entra en la cola de confirmación de salida por 20 minutos. Si no se registra la salida en ese plazo, el sistema solicita un nuevo cobro calculado desde el ingreso original.

El logo `assets/parking.svg` se usa como identidad visual y favicon. La interfaz se adapta a escritorio, tabletas y celulares mediante `css/responsive.css`; en pantallas pequeñas la navegación se coloca arriba del contenido y las tablas pueden desplazarse horizontalmente.

El formulario valida placas con el formato `NNNN-LLL` o `NNNNN-LLL` (N: dígito, L: letra; se guardan en mayúsculas). Para registrar un vehículo solicita tipo, marca y color; las marcas conocidas aparecen en una lista y se puede escribir una marca distinta con «Otra marca». Conductor y observaciones ya no forman parte del formulario.

El botón «Modo oscuro» de la navegación cambia el tema en todas las páginas y conserva la preferencia en `localStorage`.

## Estructuras implementadas y por qué

1. **Array — vehículos activos.** Práctico para recorrer y mostrar los registros. Agregar al final: O(1) amortizado; búsqueda/eliminación por ID: O(n).
2. **Set — placas registradas.** Impide placas duplicadas entre vehículos activos. `has()` es O(1) promedio.
3. **Tabla hash con `Map` — índice placa → vehículo y espacio → vehículo.** La consulta por clave es O(1) promedio; el peor caso teórico puede ser O(n). Los índices se reconstruyen desde los arreglos, lo cual cuesta O(n).
4. **Arreglo ordenado — tabla de vehículos.** En `js/views.js` se filtra y ordena una copia por espacio y placa. El ordenamiento típico es O(n log n). Se copia para no alterar el arreglo original.
5. **Lista enlazada simple — historial.** En `js/views.js`, cada nodo conserva un evento y un enlace al siguiente. El historial se recorre para mostrar los movimientos más recientes.
6. **Stack / pila — deshacer la última salida.** En `js/state.js`, cada salida se agrega con `push()` y “Deshacer última salida” la recupera con `pop()`. La pila sigue LIFO y ambas operaciones son O(1) amortizado.

Los comentarios de `js/state.js` y `js/views.js` identifican las estructuras y explican qué rol cumplen en el flujo del sistema.

## Búsqueda y notación Big O
- Búsqueda por placa exacta en una tabla hash: O(1) promedio, aunque reconstruir el índice completo cuesta O(n).
- Búsqueda por texto libre (placa, marca, color o tipo): O(n), porque se revisan registros.
- Encontrar un espacio libre: O(m), donde `m` es el número de espacios configurados en el mapa.
- Ordenar registros para mostrarlos: O(n log n).
- No se usa un algoritmo O(n²) intencionalmente; se evita comparar cada registro contra todos los demás.

`n` representa la cantidad de vehículos o eventos. Big O explica cómo crece el trabajo al aumentar la entrada; no mide segundos exactos.

## Por qué no se usa recursividad, árboles o grafos
No se añadieron solo para contar estructuras: el flujo actual no los necesita. Una futura ampliación podría usar un árbol binario de búsqueda para indexar placas, o un grafo para representar rutas entre sectores del estacionamiento. Recursividad sería útil si se recorriera un árbol de forma recursiva, pero no aporta una ventaja clara en esta versión.

## Límites
- Guarda datos en `localStorage`, solo en ese navegador/dispositivo.
- No usa servidor ni base de datos compartida.
- Es una beta académica, no un sistema de cobro o auditoría listo para producción.
