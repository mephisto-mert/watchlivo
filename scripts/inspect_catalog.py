import json
import os

base_dir = r"c:\Users\pc\Documents\projelerim\rave_web_platform"
vault_path = os.path.join(base_dir, "main_sites_vault.json")

with open(vault_path, "r", encoding="utf-8") as f:
    data = json.load(f)

print("Root keys:", list(data.keys()))
for k in data:
    val = data[k]
    print(f"Key: {k}, type: {type(val)}, length: {len(val) if hasattr(val, '__len__') else 'N/A'}")
    if isinstance(val, dict):
        sample_subkeys = list(val.keys())[:5]
        print(f"  Sample subkeys: {sample_subkeys}")
        for sk in sample_subkeys:
            sample_val = val[sk]
            val_type = type(sample_val)
            print(f"    {sk} -> type {val_type}: {str(sample_val)[:100]}")
    elif isinstance(val, list):
        print(f"  Sample items: {val[:3]}")
