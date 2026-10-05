import sys
import cloudscraper
import warnings

# Suppress urllib3 NotOpenSSLWarning on older macs
warnings.filterwarnings("ignore", category=Warning)

def fetch_url(url):
    try:
        scraper = cloudscraper.create_scraper(browser={
            'browser': 'chrome',
            'platform': 'windows',
            'desktop': True
        })
        response = scraper.get(url, timeout=20)
        
        if response.status_code == 200:
            print(response.text)
        else:
            print(f"ERROR: HTTP {response.status_code}", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        fetch_url(sys.argv[1])
    else:
        print("ERROR: No URL provided", file=sys.stderr)
        sys.exit(1)
