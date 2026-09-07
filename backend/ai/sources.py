"""Provider references for successful tools, not invented observation citations."""
REFERENCES = {
    'get_weather_forecast': {'title': 'Open-Meteo · model weather forecast', 'url': 'https://open-meteo.com/'},
    'get_marine_conditions': {'title': 'Copernicus Marine · ocean data', 'url': 'https://marine.copernicus.eu/'},
    'get_data_availability': {'title': 'Copernicus Marine · ocean data', 'url': 'https://marine.copernicus.eu/'},
    'get_nearest_pfz': {'title': 'INCOIS · PFZ advisory', 'url': 'https://incois.gov.in/'},
    'get_pfz_details': {'title': 'INCOIS · PFZ advisory', 'url': 'https://incois.gov.in/'},
}


def tool_sources(name, result):
    if not result.success:
        return []
    if name == 'execute_plan':
        references = [REFERENCES[t['tool']] for t in result.data.get('tasks', [])
                      if t.get('status') in {'ok', 'partial'} and t.get('tool') in REFERENCES]
        return list({r['url']: r for r in references}.values())
    return [REFERENCES[name]] if name in REFERENCES else []
