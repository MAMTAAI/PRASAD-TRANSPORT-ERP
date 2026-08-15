# PRASAD TRANSPORT — DAILY SOP (Office Staff)

**Roz ka kaam sirf 3 step hai.** Isse zyada kuch nahi karna.

---

## STEP 1 — Subah: system chalu karo

Desktop par **`START PRASAD`** icon par double-click karo.
(Ya PowerShell me: `E:\PRASAD-TRANSPORT-ERP\scripts\START-PRASAD-LOCAL.ps1`)

Screen par ye dikhna chahiye — **teeno line `[ok]` honi chahiye**:

```
[ok]   PostgreSQL running
[ok]   sync tunnel up (:15432)
[ok]   ERP API up (:3300)
  Storage  : F:\Prasad_Transport_Data OK
  Cloud    : tunnel up - AWS receiving updates
```

- Koi line **laal `[down]`** dikhe to script dobara chala do. Phir bhi na sudhre to screenshot bhej do.
- **`Cloud : OFFLINE` likha ho to ghabrao mat** — kaam rukta nahi hai. Internet
  aate hi sab apne aap cloud par chala jaata hai. Books kabhi galat nahi hongi.

---

## STEP 2 — Din bhar: bill/PDF sirf ek jagah rakho

Har toll receipt, trip bill, IOCL bill, ya koi bhi PDF —
**sirf is folder me daalo:**

```
F:\Prasad_Transport_Data\uploads\
```

- IOCL ke bill → `uploads\iocl_bills\`
- Payment advice → `uploads\iocl_advices\`
- Baaki scan/photo → `uploads\scans\`

**Kabhi bhi C: drive ya Desktop par mat rakho.** C: drive sirf Windows ke liye
hai. Galti se wahan rakha to system use nahi dekh payega.

---

## STEP 3 — Shaam: bill process karo (roz ek baar)

PowerShell kholo aur ye ek line chalao:

```powershell
cd E:\PRASAD-TRANSPORT-ERP
python tools\iocl_recon\iocl_bill_automation.py
```

Ye **DRY RUN** hai — kuch likhta nahi, sirf batata hai kya hoga. Aakhir me
summary aayegi: kitne bill, kitne match hue, kitna paisa.

Summary theek lage to **wahi command `--live` ke saath** dobara chalao:

```powershell
python tools\iocl_recon\iocl_bill_automation.py --live
```

Bas. Ledger apne aap update ho jaata hai.

### Teen cheezein jo samajhni zaroori hain

1. **Dobara chala diya to kuch kharab nahi hoga.** System yaad rakhta hai kya
   post ho chuka hai. `409 DUPLICATE` dikhe to wo **sahi hai**, error nahi.
2. **`UNMATCHED_NO_TRIP`** ka matlab: us bill ki trip ERP me hai hi nahi.
   Ye bill ki galti nahi — trip entry missing hai. Operations ko bolo trip
   daale, agle din wo bill apne aap match ho jayega.
3. **Kabhi bhi `--threshold` ya `--date-tolerance` mat badlo.** Wo match
   percentage badhane ke liye nahi hai; usse galat bill galat trip par chipak
   jayega.

---

## Agar kuch galat lage

| Dikhta kya hai | Kya karo |
|---|---|
| Website par login nahi ho raha | STEP 1 dobara chalao |
| `Cloud : OFFLINE` | Kuch mat karo — internet aane par khud sudhar jata hai |
| `Storage : F: MISSING` | **Turant batao.** F: drive nahi mila — system chalu nahi hoga |
| Ledger ka total galat lag raha | **Kuch mat chhuo, turant batao.** Khud theek karne ki koshish mat karo |

**Sunhera niyam:** paise ka koi bhi aankda galat lage to usse **haath mat lagao** —
report karo. Ledger me sudhaar hamesha ek nayi reversing entry se hota hai,
purani entry mita kar kabhi nahi.
