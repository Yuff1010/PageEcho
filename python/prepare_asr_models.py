"""Download only evaluated models, pinned to revisions recorded in a manifest."""

import argparse
import json
from pathlib import Path

from asr_runtime import configure_cache


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', default='cache/asr-evaluation')
    args = parser.parse_args()
    root = configure_cache(args.cache)
    from huggingface_hub import snapshot_download

    target = root / 'models.json'
    manifest = {"version": 1, "models": {}}
    pins = json.loads(Path(__file__).with_name('evaluation-models.json').read_text(encoding='utf-8'))
    for key, model in pins['models'].items():
        repository, revision = model['repository'], model['revision']
        print(f'Downloading {key}: {repository}@{revision}', flush=True)
        model_path = snapshot_download(
            repository, revision=revision, cache_dir=str(root / 'huggingface/hub'),
            allow_patterns=['*.json', '*.yaml', '*.pt', '*.bin', '*.mvn', 'seg_dict', 'README.md'],
            # HF 0.36's Windows symlink capability cache is not thread-safe.
            # A single download worker uses its ordinary copy fallback without
            # requiring administrator privileges or changing system settings.
            max_workers=1,
        )
        manifest['models'][key] = {"repository": repository, "revision": revision, "path": model_path}
        temporary = target.with_suffix('.tmp')
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(target)
        print(f'Ready: {key}', flush=True)
    import nltk
    try:
        nltk.data.find('tokenizers/punkt_tab/english/')
    except LookupError:
        nltk.download('punkt_tab', download_dir=str(root / 'nltk'), raise_on_error=True)
    print('Ready: local Chinese alignment sentence-splitter resource', flush=True)


if __name__ == '__main__':
    main()
