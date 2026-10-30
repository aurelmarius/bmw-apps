# BMW iDrive 7 Custom Apps (MGU)

Custom applications designed for BMW iDrive 7 (MGU head units) running on BMW PHEV models (B48 petrol engine + eDrive electric motor), compatible with **Robert Nisipeanu's mgu-store** and **IterioDev's App Manager**.

---

## 📱 Applications

### 1. ⚙️ Engine Care (`engine_care`)
*PHEV engine health and oil life intelligence monitor.*

BMW PHEV powertrains frequently start the combustion engine (ICE) directly while driving under hard acceleration, often when oil and coolant are completely cold. Standard BMW CBS (Condition Based Service) service intervals assume gentle highway mileage rather than intermittent short-cycle usage. **Engine Care** tracks real combustion engine telemetry to protect the engine:

* **Real Engine Operating Hours**: Tracks ICE runtime separate from EV driving.
* **ICE vs EV Mileage Split**: Percentage and absolute km driven on pure electric vs petrol.
* **Cold Hard-Start Counter**: Logs whenever the ICE starts while the engine oil is below the cold threshold (default < 65°C) and is then put under high torque load (default > 150 Nm) or above 3,200 rpm. The oil temperature comes from the CDS bus, or from the engine unit (OBD PID 5C) when the car doesn't send it there; the coolant temperature is the last fallback.
* **Real Distance**: Km since the oil change are read from the engine unit (OBD odometer PID A6, or PID 31), estimated from the speed only when it doesn't answer.
* **BMW CBS Side by Side**: Shows the instrument cluster's own oil service countdown (distance, date, overdue) next to your own target - for display only, as BMW's countdown is condition based and not a distance counter.
* **True Oil Life Monitor**: Calculates actual oil degradation based on thermal cycles, cold starts, and combustion engine hours.
* **Configurable Thresholds**: Customizable service limits (120h–250h or 6,000–15,000 km).

### 2. ⚡ Hybrid Cost (`hybrid_cost`)
*Real-time running cost & energy split calculator.*

Compare the financial and energy efficiency of electric vs petrol driving live on your central display:

* **Live Cost per 100 km**: Real-time monetary cost (e.g. RON/100km, EUR/100km) based on instant fuel and electricity consumption.
* **Dynamic Powertrain Torque Split**: Live visual split between ICE and Electric motor torque.
* **Interactive Price Configurator**: Adjust fuel price per litre and electricity cost per kWh directly using the iDrive rotary controller or touchscreen.
* **Multi-Currency Support**: RON, EUR, USD, GBP.
* **Trip Cost Summary**: Financial tracking for current trip, last charge, and cumulative usage.

---

## 🚀 Installation

### Method 1: Via mgu-store (Recommended)
1. Open **Store** on your BMW central display.
2. Go to **Settings** -> **Add repository**.
3. Enter:
   ```text
   github.com/aurelmarius/bmw-apps
   ```
4. Select **Releases** as the source type.
5. Tap **Install** next to **Engine Care** or **Hybrid Cost**.

### Method 2: Via USB Stick
1. Download `engine_care@1.0.0.tgz` and `hybrid_cost@1.0.0.tgz` from [Releases](https://github.com/aurelmarius/bmw-apps/releases).
2. Copy the files onto a USB stick or build a USB repository:
   ```powershell
   node mgu-install.js usb-repo E:\ engine_care@1.0.0.tgz hybrid_cost@1.0.0.tgz
   ```
3. Insert the USB drive into your car and install from the **USB** page of the Store.

### Method 3: Manual Deployment via SSH
Copy the package to the head unit and run `mgu-deploy.sh`:
```bash
/var/opt/mgu-deploy/mgu-deploy.sh install --artifact engine_care@1.0.0.tgz --yes
/var/opt/mgu-deploy/mgu-deploy.sh install --artifact hybrid_cost@1.0.0.tgz --yes
```

---

## 🛠️ Technical Details

* **Platform**: BMW MGU (Media Graphics Unit) / iDrive 7
* **Framework**: Node.js OAP SDK (`oap-sdk`), BMW RHMI UI descriptions
* **Renderer**: Hardware-accelerated GPU canvas (`mgu-renderd` / `mgu-render`)
* **Signals**: BMW CDS & CDS2 bus, SOME/IP Vehicle & FES services

---

## 📄 License
Custom BMW Community Apps. Created for educational and enthusiast vehicle monitoring purposes.
