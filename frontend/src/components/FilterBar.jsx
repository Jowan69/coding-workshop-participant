import PropTypes from 'prop-types';
import { useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import ClearIcon from '@mui/icons-material/Clear';
import SearchIcon from '@mui/icons-material/Search';
import { useIsDesktop } from '../hooks/useIsDesktop';

/**
 * Search box and select filters whose state lives in the URL query, so a filtered list can be
 * bookmarked, shared and survives a reload. Pages read the same params with useFilterParams.
 *
 * @param {object} props Component props.
 * @param {{name?: string, label: string}} [props.search] Search box; its param defaults to "q".
 * @param {Array<{name: string, label: string, options: Array<{value: string, label: string}>}>}
 *   [props.filters] Select filters, each with an implicit "All" option.
 * @param {string} [props.ariaLabel] Accessible name of the filter region.
 * @returns {JSX.Element} The filter bar.
 */
export default function FilterBar({ search, filters = [], ariaLabel = 'Filters' }) {
  const [params, setParams] = useSearchParams();
  const isDesktop = useIsDesktop();
  const searchName = search?.name ?? 'q';
  const names = [...(search ? [searchName] : []), ...filters.map((filter) => filter.name)];
  const hasActive = names.some((name) => params.get(name));

  const update = (changes) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      Object.entries(changes).forEach(([name, value]) => {
        if (value) next.set(name, value);
        else next.delete(name);
      });
      return next;
    }, { replace: true });
  };

  const clearAll = () => update(Object.fromEntries(names.map((name) => [name, ''])));

  return (
    <Box
      role="search"
      aria-label={ariaLabel}
      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mb: 2 }}
    >
      {search && (
        <TextField
          type="search"
          label={search.label}
          value={params.get(searchName) ?? ''}
          onChange={(event) => update({ [searchName]: event.target.value })}
          size="small"
          sx={{ flex: isDesktop ? '1 1 280px' : '1 1 100%', maxWidth: isDesktop ? 420 : 'none' }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon aria-hidden="true" />
                </InputAdornment>
              ),
            },
          }}
        />
      )}
      {filters.map((filter) => {
        const value = params.get(filter.name) ?? '';
        // Keep a value from the URL selectable even before its options have loaded.
        const options = value && !filter.options.some((option) => option.value === value)
          ? [...filter.options, { value, label: value }]
          : filter.options;
        return (
          <TextField
            key={filter.name}
            select
            label={filter.label}
            value={value}
            onChange={(event) => update({ [filter.name]: event.target.value })}
            size="small"
            sx={{ flex: isDesktop ? '0 0 200px' : '1 1 100%' }}
          >
            <MenuItem value="">All</MenuItem>
            {options.map((option) => (
              <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
            ))}
          </TextField>
        );
      })}
      {hasActive && (
        <Button onClick={clearAll} startIcon={<ClearIcon />}>Clear filters</Button>
      )}
    </Box>
  );
}

FilterBar.propTypes = {
  search: PropTypes.shape({
    name: PropTypes.string,
    label: PropTypes.string.isRequired,
  }),
  filters: PropTypes.arrayOf(PropTypes.shape({
    name: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    options: PropTypes.arrayOf(PropTypes.shape({
      value: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    })).isRequired,
  })),
  ariaLabel: PropTypes.string,
};
